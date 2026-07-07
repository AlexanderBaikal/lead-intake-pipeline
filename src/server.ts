import express from "express";

import { config } from "./config.js";
import { pool } from "./db.js";

const app = express();
app.use(express.json());

app.post("/v1/leads", async (req, res) => {
  const { channel, text } = req.body;
  const { rows } = await pool.query(
    `INSERT INTO leads (channel, raw_text) VALUES ($1, $2) RETURNING id, status`,
    [channel, text],
  );
  res.status(201).json(rows[0]);
});

app.get("/v1/leads/:id", async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM leads WHERE id = $1`, [
    req.params.id,
  ]);
  if (rows.length === 0) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(rows[0]);
});

app.get("/health", async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true });
});

app.listen(config.port, () => {
  console.log(`listening on ${config.port}`);
});
