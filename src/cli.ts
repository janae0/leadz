import bcrypt from "bcryptjs";
import { bootstrap } from "./bootstrap.js";
import { pool, query } from "./db/pool.js";
import { tracked } from "./jobs/runs.js";
import { processPending, runWeekly } from "./jobs/weekly.js";
import { runMaintenance } from "./jobs/maintenance.js";
import { generateDraft } from "./draft/drafter.js";
import { runScheduler } from "./send/scheduler.js";
import { runWatcher } from "./watch/watcher.js";

const usage = `Usage: npm run cli -- <command>

  migrate                                 apply migrations and seed defaults
  create-user <email> <name> <role> <pw>  role is admin or outreach
  weekly                                  run the weekly lead pipeline now
  process                                 enrich and score leads that haven't been checked
  draft <leadId>                          generate a draft for one lead
  scheduler                               run one scheduler tick (sends due mail)
  watcher                                 poll Gmail once for replies, bounces, opt-outs
  maintenance                             retention and Places-data cleanup`;

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "migrate": {
      const ran = await bootstrap();
      console.log(ran.length ? `Applied: ${ran.join(", ")}` : "Database is up to date");
      break;
    }
    case "create-user": {
      const [email, name, role, password] = args;
      if (!email || !name || !["admin", "outreach"].includes(role) || !password) throw new Error(usage);
      await query(
        `INSERT INTO users (email, name, role, password_hash) VALUES (lower($1), $2, $3, $4)
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, password_hash = EXCLUDED.password_hash`,
        [email, name, role, await bcrypt.hash(password, 12)],
      );
      console.log(`User ${email} saved`);
      break;
    }
    case "weekly":
      console.log(JSON.stringify(await tracked("weekly", () => runWeekly()), null, 2));
      break;
    case "process":
      console.log(JSON.stringify(await processPending(), null, 2));
      break;
    case "draft":
      console.log(JSON.stringify(await generateDraft(Number(args[0])), null, 2));
      break;
    case "scheduler":
      console.log(JSON.stringify(await tracked("scheduler", () => runScheduler({ tickMs: 60_000 })), null, 2));
      break;
    case "watcher":
      console.log(JSON.stringify(await tracked("watcher", () => runWatcher()), null, 2));
      break;
    case "maintenance":
      console.log(JSON.stringify(await tracked("maintenance", () => runMaintenance()), null, 2));
      break;
    default:
      console.log(usage);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
