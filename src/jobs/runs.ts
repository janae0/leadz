import { one, query } from "../db/pool.js";

// Records each job run so the admin page can show when things last ran.
export async function tracked<T>(job: string, fn: () => Promise<T>): Promise<T> {
  const run = await one<{ id: number }>("INSERT INTO job_runs (job) VALUES ($1) RETURNING id", [job]);
  try {
    const result = await fn();
    await query("UPDATE job_runs SET finished_at = now(), ok = true, summary = $2 WHERE id = $1", [run!.id, JSON.stringify(result ?? null)]);
    return result;
  } catch (err) {
    await query("UPDATE job_runs SET finished_at = now(), ok = false, summary = $2 WHERE id = $1", [
      run!.id, JSON.stringify({ error: (err as Error).message }),
    ]);
    throw err;
  }
}
