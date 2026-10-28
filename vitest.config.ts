import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // DB-backed tests share one database, so run files one at a time.
    fileParallelism: false,
    testTimeout: 20000,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://leadz:leadz@localhost:5432/leadz_test",
      SESSION_SECRET: "test-secret",
      UNSUBSCRIBE_SECRET: "test-unsub-secret",
      APP_BASE_URL: "https://leadz.test",
      SENDER_EMAIL: "maria@outreach.puretech.test",
      SENDER_NAME: "Maria Lopez",
      COOKIE_SECURE: "0",
    },
  },
});
