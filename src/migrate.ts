import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { pool } from "./db.js";
import { log } from "./logger.js";

const here = dirname(fileURLToPath(import.meta.url));

const sql = await readFile(join(here, "..", "db", "schema.sql"), "utf8");
await pool.query(sql);
log.info("schema applied");
await pool.end();
