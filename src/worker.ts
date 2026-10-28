import { assertProductionConfig } from "./config.js";
import { bootstrap } from "./bootstrap.js";
import { startJobs } from "./jobs/schedule.js";

// The always-on worker process for when jobs run separately from the web app.
async function main() {
  assertProductionConfig();
  await bootstrap();
  startJobs();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
