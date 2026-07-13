import pg, { Pool } from "pg";

import { config } from "./config.js";

/**
 * `pg` hands back int8 as a string, because a bigint can exceed what a double
 * represents exactly. Every int8 here is a row counter rather than an id minted
 * elsewhere, so staying under 2^53 outlasts the service — and the API documents
 * these as integers, which is a promise a quoted string quietly breaks.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, Number);

export const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
