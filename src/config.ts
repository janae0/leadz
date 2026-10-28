// Environment configuration. Everything J tunes day to day lives in the
// settings table instead (see settings.ts); this file is for secrets and wiring.

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== "") return v;
  if (fallback !== undefined) return fallback;
  return "";
}

export const config = {
  databaseUrl: env("DATABASE_URL", "postgres://leadz:leadz@localhost:5432/leadz"),
  port: Number(env("PORT", "3000")),
  appBaseUrl: env("APP_BASE_URL", "http://localhost:3000").replace(/\/$/, ""),
  sessionSecret: env("SESSION_SECRET", "dev-only-session-secret"),
  // Secure cookies need HTTPS end to end (or a proxy setting X-Forwarded-Proto).
  cookieSecure: env("COOKIE_SECURE", env("APP_BASE_URL").startsWith("https://") ? "1" : "0") === "1",
  unsubscribeSecret: env("UNSUBSCRIBE_SECRET", "dev-only-unsubscribe-secret"),
  formWebhookSecret: env("FORM_WEBHOOK_SECRET"),
  timezone: env("TIMEZONE", "America/New_York"),

  // Lead data
  googlePlacesApiKey: env("GOOGLE_PLACES_API_KEY"),
  pageSpeedApiKey: env("PAGESPEED_API_KEY"),
  nyOpenDataAppToken: env("NY_OPEN_DATA_APP_TOKEN"),
  nyFilingsDataset: env("NY_FILINGS_DATASET", "n9v6-gdp6"),

  // Drafting
  anthropicModel: env("CLAUDE_MODEL", "claude-haiku-5-5"),

  // Sending (Gmail API on the outreach Workspace mailbox)
  gmailClientId: env("GMAIL_CLIENT_ID"),
  gmailClientSecret: env("GMAIL_CLIENT_SECRET"),
  gmailRefreshToken: env("GMAIL_REFRESH_TOKEN"),
  senderEmail: env("SENDER_EMAIL"),
  senderName: env("SENDER_NAME"),
  adminAlertEmail: env("ADMIN_ALERT_EMAIL"),
  replyNotifyEmail: env("REPLY_NOTIFY_EMAIL"),

  // Set DRY_RUN=1 to log sends instead of calling Gmail.
  dryRun: env("DRY_RUN") === "1",
};

// Refuse to serve real traffic with the development secrets.
export function assertProductionConfig(): void {
  if (process.env.NODE_ENV !== "production") return;
  const problems: string[] = [];
  if (!process.env.SESSION_SECRET) problems.push("SESSION_SECRET");
  if (!process.env.UNSUBSCRIBE_SECRET) problems.push("UNSUBSCRIBE_SECRET");
  if (!config.appBaseUrl.startsWith("https://")) problems.push("APP_BASE_URL (must be https)");
  if (!config.dryRun && (!config.senderEmail || !config.senderName)) problems.push("SENDER_EMAIL and SENDER_NAME");
  if (problems.length) throw new Error(`Missing production configuration: ${problems.join(", ")}`);
}
