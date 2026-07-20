# Lead intake pipeline

Takes an enquiry written in plain language, pulls the useful fields out of it,
writes it to the CRM and notifies whoever handles it.

The problem is a boring one. A message shows up on WhatsApp, something like
*"hola, necesito precio para lavado de 3 camionetas mañana temprano"*, and
someone reads it, works out what's being asked and retypes it into a
spreadsheet. Thirty times a day. The ones that come in at midnight get read at
noon, a few get typed in twice, and some never get typed in at all.

```
POST /v1/leads ──▶ leads (idempotent insert) ──▶ jobs
                                                  │
                                    ┌─────────────┴─────────────┐  claimed with
                                    │   worker (run N of them)  │  FOR UPDATE
                                    └─────────────┬─────────────┘  SKIP LOCKED
                                                  │
              extract ────────────────────────────┤  structured output,
              (LLM, or the deterministic parser)   │  deterministic fallback
                                                  │
              review_gate ────────────────────────┤  holds the lead if a person
                                                  │  has to answer something
              deliver_crm ──────────────────────── │  token bucket, 60/min
                                                  │
              notify ─────────────────────────────┘  one message per lead
```

## Running it

You need Docker and Node 22. No API key required; without one it runs on the
deterministic parser.

```bash
cp .env.example .env
docker compose up -d          # Postgres on :5433
npm install && npm run migrate
npm start                     # http://localhost:3210
npm run worker                # in a second terminal
```

Open <http://localhost:3210>, send an enquiry and watch the steps resolve. Send
one with no phone number in it and it stops for a person instead; you answer it
at <http://localhost:3210/review.html>.

```bash
npm test        # 74 unit tests, no database needed
npm run eval    # 20 saved enquiries scored field by field
npm run typecheck
```

### Which extractor

Three, behind one interface (`src/llm/provider.ts`). Switching is one variable;
nothing else in the pipeline knows which one is running.

| `LLM_PROVIDER` | Needs | Costs | What it is |
|---|---|---|---|
| `mock` (default) | nothing | — | The deterministic parser. Boots anywhere, runs in CI. |
| `ollama` | Ollama + a pulled model | — | A real model on your own machine. |
| `anthropic` | `ANTHROPIC_API_KEY` | per call | A hosted model, priced and metered. |

```bash
LLM_PROVIDER=ollama  OLLAMA_MODEL=qwen2.5:14b-instruct-q4_K_M  npm run worker
```

The model has to support schema-constrained output. Ollama compiles the
extraction schema into a sampling grammar, and some quantized builds accept it
and then die: `gemma3:12b-it-qat` answers fine untyped and returns
`failed to load model vocabulary required for format` the moment a schema is
attached. qwen2.5 works.

Only `anthropic` is metered, and that is the flag the pipeline gates on — so
the cost ledger and the budget ceiling are exactly the parts a local model
cannot show you. The reverse is also true: nothing about the queue, the review
gate or the delivery path changes with the provider, which is most of the
system.

## Why it's built the way it is

A few things here look over-built for a form handler. Each one is there for a
reason, and the reason is written down next to it.

**Rate limiting.** The CRM takes 60 writes a minute and returns 429 past that.
So delivery goes through a token bucket sized to that limit
(`src/ratelimit.ts`) rather than just retrying when it fails. Retrying works,
it's just wasteful: you spend a round trip finding out something you could have
known. Worth knowing that the bucket lives in the worker process, so the real
limit is 60/min per worker (see Limits).

**Duplicate webhooks.** Webhooks are at-least-once, so the same enquiry turns
up again any time a delivery gets retried. Dedup is a `UNIQUE` constraint on an
idempotency key: the caller's if they sent one, otherwise a hash of channel,
contact and text. The insert is the check, so there's no window between looking
and writing. The second delivery gets a 200 and the id of the original lead.

The upsert is `ON CONFLICT DO UPDATE` and not `DO NOTHING`, which is a sharper
distinction than it looks. `DO NOTHING` gives you no row back on conflict, and
a `SELECT` next to it only sees the statement's own snapshot, so if a competing
transaction is still open you find nothing either way and return a 500 for
exactly the case the whole thing was supposed to handle. `DO UPDATE` waits for
that transaction and hands back the surviving row. `xmax = 0` then tells you
whether you were the one who inserted it.

**Why a model at all.** The input is human text in two languages, misspelled,
usually without accents, often switching between them mid-sentence. Rules fall
apart on that. Every field in the extraction schema is nullable on purpose: a
field left empty costs someone ten seconds, a field filled in wrongly books the
wrong day.

**Cost.** The form is public and model calls cost money, so a spam burst
shouldn't turn into an unbounded bill. Calls are priced from published rates
and written to a ledger, and the ceiling is checked before the call using the
counted input tokens plus worst-case output (`src/budget.ts`). Checking
afterwards only tells you how far over you went. Costs are stored as integer
micro-dollars, since a price per million tokens in dollars is the same number
per token in micro-dollars, and that keeps the arithmetic exact.

**When the model doesn't cooperate.** It can refuse, it can truncate, it can be
over budget. None of those should lose the enquiry, so all three fall through
to a deterministic parser that returns the same schema. The lead gets tagged
`extraction_source: heuristic` so you can see it happened.

**Timezones.** Enquiries are stamped in UTC, the business books in UTC-5. A
message sent at 22:30 in Panama already has tomorrow's UTC date on it, so
"mañana" resolved against UTC lands two days out, and nothing about that looks
wrong until someone shows up on the wrong morning. Relative dates resolve
against the business calendar instead (`src/time.ts`). This is the kind of bug
that only shows up end to end, so there is a regression test pinning it in
`test/time.test.ts`.

## Leads that stop for a person

Some leads can't be finished automatically. Three cases get held:

- No phone and no email anywhere in the message. The CRM record would have no
  way to reply.
- The service came out as `other`. The CRM routes on that field, so someone has
  to pick one.
- The date came out earlier than the day the message arrived. That's "el lunes"
  resolved against the wrong week.

If a model produced the fields, the deterministic parser reads the same text as
a second opinion. Where the two disagree on service, urgency, date or vehicle
count, the lead is held as well. Disagreements about the customer's name are
ignored, since the parser misses names constantly and the name doesn't change
where the lead goes.

The model is never asked how confident it is. It sounds just as sure when it's
wrong, so the number doesn't help.

A held lead stops before delivery, not after it. Nothing is written to
`deliveries` until someone answers. The queue is at `/review.html`.

### Decisions have to survive the next run

Every decision is stored per field in `review_decisions`, including rejections.

That matters the next time the same lead is processed, whether that's a retry
or a re-run after the text was updated. Extraction finds the same value it found
before, and with nothing recorded it would go straight back into the record.
Decisions are merged on top of whatever extraction just produced, so a rejected
field comes out empty every time. There's a test for exactly that: reject the
contact, add a phone number to the text, re-run, the field stays empty.

Corrections go through the same schema the model's output does, so typing `0`
into `vehicle_count` gets a 400 instead of a broken CRM record.

Only nullable fields can be rejected outright. `service`, `urgency` and
`vehicle_count` have no empty value in the contract, so a wrong one has to be
corrected. That's the schema deciding, not a rule bolted on beside it.

### The queue measures the extractor

Every decision is a labelled example for free: the machine proposed something
and a person either kept it or didn't. `/v1/review/agreement` reports, per
field, how often it was kept.

Once a field has been kept 95% of the time over at least 20 decisions, it stops
being held. Both numbers are configurable, and the second one is what stops
three lucky calls in a row from switching a field off. Fields people keep
correcting keep coming back.

## Worth a look

| Path | Why |
|---|---|
| `src/queue.ts` | The claim query. `FOR UPDATE SKIP LOCKED` is what lets N workers share one table without a broker. Without it they queue up behind the same row and the extra processes get you nothing. |
| `src/budget.ts` | The pre-flight cost check and the ledger behind it. |
| `src/llm/anthropic.ts` | Structured output via the response schema, refusal and truncation handling, and the prompt ordered stable-part-first so the cached prefix survives. |
| `src/llm/ollama.ts` | The local provider. Same schema, no SDK. Mostly about which failures degrade to the parser and which ones are allowed to fail the job. |
| `src/llm/heuristic.ts` | The deterministic parser. Doubles as the offline provider and the production fallback. |
| `src/review.ts` | What gets held and why, and how a person's decision is merged back over the next extraction. |
| `src/agreement.ts` | How often people kept the machine's answer, and when a field stops being held. |
| `src/idempotency.ts` | Which key a delivery dedups on, and why the parts are joined on NUL. |
| `src/server.ts` | The idempotent insert. |
| `src/time.ts` | Sixty lines on what a date is and why it isn't a timestamp. |
| `evals/` | 20 saved enquiries, scored per field. |
| `openapi.yaml` | The contract. `test/contract.test.ts` fails the build if it drifts from what the server actually validates. |

## Evals

Prompts get edited by feel unless something is checking them. `npm run eval`
runs 20 real message shapes (Spanish and English, typos, fleet counts, relative
dates, one truncated message, one enquiry that doesn't mention a service at
all) and scores each extracted field against an expectation written by hand:

```
ok   es-basic-tomorrow        8/8
ok   en-detailing-weekday     8/8
...
per field:
  requested_date   20/20
  service          20/20
  vehicle_types    20/20

accuracy 160/160 = 100.0% (threshold 90%)
```

Every case asserts all eight scored fields. That is deliberate: an earlier
version of this file left a field out of `expect` where the parser got it
wrong, which is a way of scoring 100% without being right. A `null` is an
expectation like any other, so absent contacts and unnamed vehicle types are
written down rather than skipped.

CI runs it against the deterministic parser, so no key and no database needed,
and a change that breaks the fallback fails the build. Point `LLM_PROVIDER` at
`anthropic` or `ollama` and the same cases measure that model instead. Both
providers send a byte-identical prompt (`src/llm/prompt.ts`) — two copies would
drift, and then the comparison would be measuring the prompt.

Each case has a `note` on it saying what behaviour it pins, so when one fails
you get told what broke rather than watching a number go down. Several of the
notes name a specific parser bug the case exists to catch — plurals, verb
stems, a case-sensitive name prefix, a weekday resolving to the day it was
sent, an ISO date read as a phone number, a countable-noun list out of sync
with the type list.

## Deploying

Anywhere with Node and Postgres works: Fly, Render, Railway, a VPS. The server
and the worker are separate processes against the same database, and the worker
scales horizontally.

```bash
DATABASE_URL=...  npm run migrate
DATABASE_URL=...  npm start      # web
DATABASE_URL=...  npm run worker # one or more
```

## Limits

- One queue, no priority lanes. A 500-lead import will sit in front of a
  walk-in enquiry. The fix is a priority column in the claim query's
  `ORDER BY`.
- Dead jobs stop where they land. `status='dead'` after five attempts and
  nobody gets paged. In production they'd need to go somewhere a human looks.
- Both ceilings are per-process, and workers scale horizontally. The token
  bucket is in memory, so N workers pace at N x 60 writes/min rather than 60.
  The budget gate reads the ledger and spends with no lock in between, so N
  workers can all clear the same remaining balance and go over it. One worker
  is fine. Past that, both of these want shared state: a `rate_limits` row
  taken with `FOR UPDATE`, or Redis if there's already one around.
- The budget ceiling is per-deployment, not per-tenant, so one noisy customer
  can spend someone else's allowance.
- Extraction is single-pass. No confidence score and no second opinion on a
  message with little to go on. If the stakes were higher I'd extract, then
  have a cheaper model check the extraction against the original text and flag
  the disagreements.
- `vehicle_types` is a free-text array. It should be an enum. It isn't yet
  because the real taxonomy depends on which CRM you attach.

## At a hundred times the volume

The queue goes first. `SKIP LOCKED` polling is fine into the low thousands per
minute, after which the wasted round trips start to add up, so `LISTEN/NOTIFY`
to wake the workers, or a real broker. Extraction would move to the Batch API
for anything that isn't user-facing, at half the price. The ledger would want a
rollup table instead of summing a day of rows on every call. At the volume this
was built for, none of that is worth doing.

## Stack

TypeScript, Node 22, Express, Postgres (nothing else), the Anthropic SDK with
structured outputs, zod, `node:test`. The Ollama provider is `fetch` against a
local HTTP endpoint, so it adds no dependency.

MIT.
