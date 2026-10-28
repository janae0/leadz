import { assertProductionConfig, config } from "./config.js";
import { bootstrap } from "./bootstrap.js";
import { createApp } from "./web/app.js";

async function main() {
  assertProductionConfig();
  await bootstrap();
  createApp().listen(config.port, () => {
    console.log(`Leadz review app on ${config.appBaseUrl} (port ${config.port})`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
