import express from "express";

import { config } from "./config.js";
import { pool } from "./db.js";
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

  const { rows } = await pool.query(
    `INSERT INTO leads (channel, raw_text, contact_hint) VALUES ($1, $2, $3)
       RETURNING id, status`,
    [input.channel, input.text, input.contact ?? null],
  );

  await enqueue(rows[0].id);
  res.status(202).json(rows[0]);
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
