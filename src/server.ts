import express from "express";

import { config } from "./config.js";
import { pool } from "./db.js";
import { log } from "./logger.js";
import { enqueue } from "./queue.js";

const app = express();
app.use(express.json());

app.post("/v1/leads", async (req, res) => {
  const { channel, text } = req.body ?? {};
  if (typeof channel !== "string" || typeof text !== "string" || text.length === 0) {
    res.status(400).json({ error: "channel and text are required" });
    return;
  }

  const { rows } = await pool.query(
    `INSERT INTO leads (channel, raw_text) VALUES ($1, $2) RETURNING id, status`,
    [channel, text],
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
