import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import express, { type ErrorRequestHandler } from "express";

import { agreementByField, promotionRules } from "./agreement.js";
import { currentSpend } from "./budget.js";
import { config } from "./config.js";
import { pool } from "./db.js";
import { resolveKey } from "./idempotency.js";
import { log } from "./logger.js";
import { microToUsd } from "./pricing.js";
import { enqueue } from "./queue.js";
import {
  checkMerged,
  DecisionInput,
  mergeDecisions,
  pendingReviews,
  reviewDetail,
  saveDecisions,
} from "./review.js";
import { LeadInput } from "./schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: "256kb" }));
app.use(express.static(join(here, "..", "public")));

app.post("/v1/leads", async (req, res) => {
  const parsed = LeadInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", detail: parsed.error.issues });
    return;
  }
  const input = parsed.data;

  const resolved = resolveKey(input, req.header("Idempotency-Key"));
  if (!resolved.ok) {
    res.status(400).json({ error: resolved.error });
    return;
  }

  // The insert is the dedup: the unique index decides, not a prior SELECT, so
  // two concurrent deliveries of the same webhook cannot both win.
  //
  // DO UPDATE rather than DO NOTHING, and the no-op assignment, are both load
  // bearing. DO NOTHING returns no row on conflict, and a plain SELECT beside
  // it reads the statement's snapshot — so a delivery that lands while a
  // competing transaction is still open finds neither, and the caller gets a
  // 500 for the exact race this is meant to absorb. DO UPDATE waits for that
  // transaction instead and always returns the surviving row.
  //
  // `xmax = 0` is true only for a row this statement inserted, which is what
  // separates a fresh lead from a duplicate without a second query.
  const { rows } = await pool.query<{ id: number; status: string; inserted: boolean }>(
    `INSERT INTO leads (idempotency_key, channel, raw_text, contact_hint)
          VALUES ($1, $2, $3, $4)
     ON CONFLICT (idempotency_key)
     DO UPDATE SET idempotency_key = leads.idempotency_key
       RETURNING id, status, (xmax = 0) AS inserted`,
    [resolved.key, input.channel, input.text, input.contact ?? null],
  );

  // DO UPDATE always returns the surviving row, so there is no empty case.
  const lead = rows[0]!;

  if (lead.inserted) {
    await enqueue(lead.id);
    res.status(202).json({ id: lead.id, status: lead.status, duplicate: false });
    return;
  }

  res.status(200).json({ id: lead.id, status: lead.status, duplicate: true });
});

app.get("/v1/leads/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "invalid_id" });
    return;
  }

  const lead = await pool.query(
    `SELECT id, channel, raw_text, status, extracted, extraction_source, review_flags,
            received_at, completed_at
       FROM leads WHERE id = $1`,
    [id],
  );
  if (lead.rowCount === 0) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const steps = await pool.query(
    `SELECT name, ok, detail, ms, created_at FROM steps WHERE lead_id = $1 ORDER BY id`,
    [id],
  );

  res.json({ ...lead.rows[0], steps: steps.rows });
});

app.get("/v1/leads", async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, channel, status, extraction_source, received_at
       FROM leads ORDER BY id DESC LIMIT 20`,
  );
  res.json({ leads: rows });
});

app.get("/v1/review", async (_req, res) => {
  res.json({ leads: await pendingReviews() });
});

/**
 * Declared above `/v1/review/:id` on purpose. Express matches in order, and a
 * parameter route placed first would swallow the word "agreement".
 */
app.get("/v1/review/agreement", async (_req, res) => {
  res.json({
    threshold: promotionRules.threshold,
    min_decisions: promotionRules.minDecisions,
    fields: await agreementByField(),
  });
});

app.get("/v1/review/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "invalid_id" });
    return;
  }

  const detail = await reviewDetail(id);
  if (!detail) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(detail);
});

app.post("/v1/review/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "invalid_id" });
    return;
  }

  const parsed = DecisionInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", detail: parsed.error.issues });
    return;
  }

  const detail = await reviewDetail(id);
  if (!detail) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (detail.status !== "needs_review" || !detail.extracted) {
    res.status(409).json({ error: "not_awaiting_review", status: detail.status });
    return;
  }

  // A correction typed by a person goes through the same contract the model's
  // output does, so a bad value is refused here rather than by the CRM.
  const merged = checkMerged(mergeDecisions(detail.extracted, parsed.data.decisions));
  if (!merged.success) {
    res.status(400).json({ error: "invalid_value", detail: merged.error.issues });
    return;
  }

  await saveDecisions(id, parsed.data.decisions, detail.extracted);

  // The lead stops awaiting a person here, not when a worker gets to it. Left
  // on `needs_review` until then, it sat in the very queue this request just
  // answered: whoever released it watched it stay listed, and a second click
  // came back 409. The re-run knows it by its decisions, not by this status.
  await pool.query(
    `UPDATE leads SET status = 'queued', review_flags = NULL WHERE id = $1`,
    [id],
  );

  // Back through the pipeline rather than delivered from here. The gate runs
  // again with these decisions settled, so a field the person left open still
  // holds the lead, and there is only one path to the CRM.
  await enqueue(id);

  res.status(202).json({ id, status: "queued", extracted: merged.data });
});

app.get("/v1/budget", async (_req, res) => {
  const state = await currentSpend();
  res.json({
    window: "24h",
    model: config.llmModel,
    provider: config.llmProvider,
    spent_usd: Number(microToUsd(state.spentMicroUsd).toFixed(6)),
    ceiling_usd: Number(microToUsd(state.ceilingMicroUsd).toFixed(2)),
    remaining_usd: Number(microToUsd(state.remainingMicroUsd).toFixed(6)),
  });
});

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (error) {
    res.status(503).json({ ok: false, error: String(error) });
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: "not_found" });
});

/**
 * Express 5 forwards rejected handlers here. Without it they reach the default
 * handler, which answers an API documented as JSON with an HTML stack trace.
 */
const onError: ErrorRequestHandler = (error, _req, res, _next) => {
  // A body express could not parse is the caller's mistake, not ours.
  if (error instanceof SyntaxError && "body" in error) {
    res.status(400).json({ error: "invalid_json" });
    return;
  }
  log.error("request failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  res.status(500).json({ error: "internal_error" });
};
app.use(onError);

const server = app.listen(config.port, () => {
  log.info("intake listening", { port: config.port, provider: config.llmProvider });
});

// Stop accepting connections, let in-flight requests finish, then release the
// pool — the same contract the worker honours, so a deploy drains both ends.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log.info("draining, will exit when in-flight requests finish");
    server.close(async () => {
      await pool.end();
      log.info("intake stopped");
    });
  });
}
