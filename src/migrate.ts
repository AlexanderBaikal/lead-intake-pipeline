import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { pool } from "./db.js";

const here = dirname(fileURLToPath(import.meta.url));

const sql = await readFile(join(here, "..", "db", "schema.sql"), "utf8");
await pool.query(sql);
console.log("schema applied");
await pool.end();
