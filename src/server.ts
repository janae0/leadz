import { assertProductionConfig, config } from "./config.js";
import { bootstrap } from "./bootstrap.js";
import { startJobs } from "./jobs/schedule.js";
import { createApp } from "./web/app.js";

async function main() {
  assertProductionConfig();
  await bootstrap();
  createApp().listen(config.port, () => {
    console.log(`Leadz review app on ${config.appBaseUrl} (port ${config.port})`);
  });
  // On a single-service host (such as Railway), RUN_JOBS=1 runs the scheduled
  // jobs in this process instead of a separate worker. Advisory locks keep a
  // job from running twice if both are on.
  if (process.env.RUN_JOBS === "1") startJobs();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
