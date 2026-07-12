import express from "express";

import { config } from "./config.js";
import { pool } from "./db.js";
import { resolveKey } from "./idempotency.js";
import { log } from "./logger.js";
import { enqueue } from "./queue.js";
import { LeadInput } from "./schema.js";

const app = express();
app.use(express.json());

app.post("/v1/leads", async (req, res) => {
  const parsed = LeadInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", detail: parsed.error.issues });
    return;
  }
  const input = parsed.data;

  const key = resolveKey(input, req.header("Idempotency-Key")).key;

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
    [key, input.channel, input.text, input.contact ?? null],
  );

  const lead = rows[0];

  if (lead.inserted) {
    await enqueue(lead.id);
    res.status(202).json({ id: lead.id, status: lead.status, duplicate: false });
    return;
  }

  res.status(200).json({ id: lead.id, status: lead.status, duplicate: true });
});

app.get("/v1/leads/:id", async (req, res) => {
  const lead = await pool.query(`SELECT * FROM leads WHERE id = $1`, [req.params.id]);
  if (lead.rowCount === 0) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const steps = await pool.query(
    `SELECT name, ok, detail, ms, created_at FROM steps WHERE lead_id = $1 ORDER BY id`,
    [req.params.id],
  );

  res.json({ ...lead.rows[0], steps: steps.rows });
});

app.get("/health", async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true });
});

app.listen(config.port, () => {
  log.info("intake listening", { port: config.port });
});
