# Lead intake pipeline

Takes an enquiry written in plain language, pulls the useful fields out of it,
writes it to the CRM and notifies whoever handles it.

A message shows up on WhatsApp — *"hola, necesito precio para lavado de 3
camionetas mañana temprano"* — and someone reads it, works out what's being
asked and retypes it into a spreadsheet. Thirty times a day. The ones that
come in at midnight get read at noon, a few get typed in twice, some never at
all.

```
POST /v1/leads ──▶ leads (idempotent insert) ──▶ jobs
                                                  │
                                    ┌─────────────┴─────────────┐  claimed with
                                    │   worker (run N of them)  │  FOR UPDATE
                                    └─────────────┬─────────────┘  SKIP LOCKED
                                                  │
              extract ────────────────────────────┤  structured output,
                                                  │  deterministic fallback
              review_gate ────────────────────────┤  holds the lead if a person
                                                  │  has to answer something
              deliver_crm ────────────────────────┤  token bucket, 60/min
                                                  │
              notify ─────────────────────────────┘  one message per lead
```

## Running it

Docker and Node 22. No API key needed — without one it runs on the
deterministic parser.

```bash
cp .env.example .env
docker compose up -d          # Postgres on :5433
npm install && npm run migrate
npm start                     # http://localhost:3210
npm run worker                # in a second terminal
```

Send an enquiry at <http://localhost:3210> and watch the steps resolve. Send
one with no phone number and it stops for a person instead; answer it at
`/review.html`.

```bash
npm test        # 74 unit tests, no database needed
npm run eval    # 20 saved enquiries scored field by field
npm run typecheck
```

## Which extractor

Three, behind one interface (`src/llm/provider.ts`). Switching is one variable.

| `LLM_PROVIDER` | Needs | What it is |
|---|---|---|
| `mock` (default) | nothing | The deterministic parser. Boots anywhere, runs in CI. |
| `ollama` | Ollama + a pulled model | A real model on your own machine. |
| `anthropic` | `ANTHROPIC_API_KEY` | A hosted model, priced and metered. |

```bash
LLM_PROVIDER=ollama OLLAMA_MODEL=qwen2.5:14b-instruct-q4_K_M npm run worker
```

The model has to support schema-constrained output. Some quantized builds
accept the schema and then die — `gemma3:12b-it-qat` answers fine untyped and
returns `failed to load model vocabulary required for format` the moment a
schema is attached. qwen2.5 works.

## Why it's built this way

**Duplicates.** Webhooks are at-least-once. Dedup is a `UNIQUE` constraint on
an idempotency key — the caller's, or a hash of channel, contact and text. The
insert is the check, so there's no window between looking and writing. It's
`ON CONFLICT DO UPDATE`, not `DO NOTHING`: `DO NOTHING` returns no row, and a
`SELECT` beside it only sees its own snapshot, so a competing open transaction
gets you a 500 for exactly the case this was meant to handle.

**Rate limiting.** The CRM takes 60 writes/min and 429s past that, so delivery
goes through a token bucket sized to the limit rather than retrying into it.

**Cost.** The form is public, so a spam burst shouldn't become an unbounded
bill. Calls are priced from published rates into a ledger, and the ceiling is
checked *before* the call using counted input tokens plus worst-case output
(`src/budget.ts`). Stored as integer micro-dollars so the arithmetic is exact.

**Fallback.** Refusal, truncation, over budget — none of those should lose the
enquiry. All three fall through to a deterministic parser returning the same
schema, tagged `extraction_source: heuristic`.

**Timezones.** Enquiries are stamped UTC, the business books UTC-5. A message
sent at 22:30 in Panama already carries tomorrow's UTC date, so "mañana"
resolved against UTC lands two days out and nothing looks wrong until someone
shows up on the wrong morning. Relative dates resolve against the business
calendar (`src/time.ts`), pinned by a regression test.

Every field in the schema is nullable on purpose: an empty field costs someone
ten seconds, a wrong one books the wrong day.

## Leads that stop for a person

Held when there's no contact of any kind, when `service` came out `other` (the
CRM routes on it), or when the date resolved earlier than the message arrived.
If a model produced the fields, the parser reads the same text as a second
opinion and disagreement on service, urgency, date or vehicle count holds the
lead too. Name disagreements are ignored — the parser misses names constantly
and the name doesn't change where the lead goes. The model is never asked how
confident it is; it sounds just as sure when it's wrong.

Decisions are stored per field in `review_decisions`, rejections included, and
merged on top of whatever extraction produces next time — otherwise a re-run
puts the rejected value straight back. Corrections go through the same schema
as the model's output, so `vehicle_count: 0` gets a 400.

Each decision is also a free labelled example. `/v1/review/agreement` reports
how often a field was kept; once it's been kept 95% of the time over at least
20 decisions it stops being held. Fields people keep correcting keep coming
back.

## Worth a look

| Path | Why |
|---|---|
| `src/queue.ts` | The claim query. `FOR UPDATE SKIP LOCKED` is what lets N workers share one table without a broker. |
| `src/budget.ts` | Pre-flight cost check and the ledger behind it. |
| `src/llm/anthropic.ts` | Structured output, refusal and truncation handling, prompt ordered stable-part-first so the cached prefix survives. |
| `src/llm/heuristic.ts` | The deterministic parser — offline provider and production fallback. |
| `src/review.ts` | What gets held, and how a decision merges over the next extraction. |
| `src/time.ts` | Sixty lines on what a date is and why it isn't a timestamp. |
| `evals/` | 20 saved enquiries, scored per field. |
| `openapi.yaml` | The contract. `test/contract.test.ts` fails the build if it drifts. |

## Evals

Prompts get edited by feel unless something is checking them. `npm run eval`
scores 20 real message shapes — Spanish and English, typos, fleet counts,
relative dates, a truncated message, one enquiry naming no service — against
expectations written by hand:

```
per field:
  requested_date   20/20
  service          20/20
  vehicle_types    20/20

accuracy 160/160 = 100.0% (threshold 90%)
```

Every case asserts all eight fields, `null` included; an earlier version left a
field out of `expect` where the parser got it wrong, which is a way of scoring
100% without being right. CI runs it against the parser, so a change that
breaks the fallback fails the build. Both providers send a byte-identical
prompt (`src/llm/prompt.ts`) — two copies would drift and the comparison would
be measuring the prompt.

## Deploying

Anywhere with Node and Postgres. Server and worker are separate processes
against the same database; the worker scales horizontally.

```bash
DATABASE_URL=... npm run migrate
DATABASE_URL=... npm start      # web
DATABASE_URL=... npm run worker # one or more
```

## Limits

- One queue, no priority lanes. A 500-lead import sits in front of a walk-in.
- Dead jobs stop where they land — `status='dead'` after five attempts and
  nobody gets paged.
- Both ceilings are per-process. The token bucket is in memory, so N workers
  pace at N × 60 writes/min; the budget gate reads the ledger and spends with
  no lock in between. One worker is fine. Past that both want shared state.
- The budget ceiling is per-deployment, not per-tenant.
- Extraction is single-pass, no second opinion. Higher stakes would want a
  cheaper model checking the extraction against the original text.
- `vehicle_types` is free text. It should be an enum, but the taxonomy depends
  on which CRM you attach.

At a hundred times the volume the queue goes first: `SKIP LOCKED` polling is
fine into the low thousands per minute, after which `LISTEN/NOTIFY` or a real
broker. Batch API for anything not user-facing, and a rollup table instead of
summing a day of ledger rows per call.

## Stack

TypeScript, Node 22, Express, Postgres (nothing else), the Anthropic SDK with
structured outputs, zod, `node:test`. The Ollama provider is `fetch` against a
local endpoint, so it adds no dependency.

MIT.
