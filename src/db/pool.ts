import pg from "pg";
import { config } from "../config.js";

// Return NUMERIC as a JS number; ratings are the only NUMERIC column.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
// COUNT(*) comes back as int8; our counts always fit in a JS number.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

export async function query<T extends pg.QueryResultRow = any>(
  sql: string,
  params: unknown[] = [],
  db: Queryable = pool,
): Promise<T[]> {
  const res = await db.query<T>(sql, params);
  return res.rows;
}

export async function one<T extends pg.QueryResultRow = any>(
  sql: string,
  params: unknown[] = [],
  db: Queryable = pool,
): Promise<T | undefined> {
  const rows = await query<T>(sql, params, db);
  return rows[0];
}

export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Runs fn only if no other process holds the named lock, so overlapping
// cron ticks (or two workers) never run the same job at once.
export async function withAdvisoryLock<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [name],
    );
    if (!rows[0].locked) return undefined;
    try {
      return await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [name]);
    }
  } finally {
    client.release();
  }
}
