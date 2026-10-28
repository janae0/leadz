import cron from "node-cron";
import { config } from "../config.js";
import { tracked } from "./runs.js";
import { runWeekly } from "./weekly.js";
import { runMaintenance } from "./maintenance.js";
import { runScheduler } from "../send/scheduler.js";
import { runWatcher } from "../watch/watcher.js";

// A weekly lead run, plus the scheduler and reply watcher every 10 minutes.
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

export function startJobs(): void {
  const opts = { timezone: config.timezone };
  cron.schedule(schedules.weekly, job("weekly", () => runWeekly()), opts);
  cron.schedule(schedules.scheduler, job("scheduler", () => runScheduler()), opts);
  cron.schedule(schedules.watcher, job("watcher", () => runWatcher()), opts);
  cron.schedule(schedules.maintenance, job("maintenance", () => runMaintenance()), opts);
  console.log("Scheduled jobs started", schedules, config.dryRun ? "(DRY_RUN: no mail is sent)" : "");
}
