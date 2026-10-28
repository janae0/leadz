import cron from "node-cron";
import { assertProductionConfig, config } from "./config.js";
import { bootstrap } from "./bootstrap.js";
import { tracked } from "./jobs/runs.js";
import { runWeekly } from "./jobs/weekly.js";
import { runMaintenance } from "./jobs/maintenance.js";
import { runScheduler } from "./send/scheduler.js";
import { runWatcher } from "./watch/watcher.js";

// The always-on worker: a weekly lead run, plus the scheduler and reply
// watcher every 10 minutes.
const schedules = {
  weekly: process.env.WEEKLY_CRON ?? "0 5 * * 1", // Mondays 5:00 a.m.
  scheduler: process.env.SCHEDULER_CRON ?? "*/10 * * * *",
  watcher: process.env.WATCHER_CRON ?? "5-59/10 * * * *",
  maintenance: process.env.MAINTENANCE_CRON ?? "30 3 * * *",
};

function job(name: string, fn: () => Promise<unknown>) {
  return async () => {
    try {
      const result = await tracked(name, fn);
      console.log(`[${new Date().toISOString()}] ${name}:`, JSON.stringify(result));
    } catch (err) {
      console.error(`[${new Date().toISOString()}] ${name} failed:`, err);
    }
  };
}

async function main() {
  assertProductionConfig();
  await bootstrap();
  const opts = { timezone: config.timezone };
  cron.schedule(schedules.weekly, job("weekly", () => runWeekly()), opts);
  cron.schedule(schedules.scheduler, job("scheduler", () => runScheduler()), opts);
  cron.schedule(schedules.watcher, job("watcher", () => runWatcher()), opts);
  cron.schedule(schedules.maintenance, job("maintenance", () => runMaintenance()), opts);
  console.log("Worker started", schedules, config.dryRun ? "(DRY_RUN: no mail is sent)" : "");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
