import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import bcrypt from "bcryptjs";
import { one, query } from "../src/db/pool.js";
import { createApp } from "../src/web/app.js";
import { config } from "../src/config.js";
import { getSettings } from "../src/settings.js";
import { ingestCandidate } from "../src/pipeline/ingest.js";
import { signatureAndFooter } from "../src/draft/templates.js";
import { unsubscribeToken } from "../src/send/mime.js";
import { isSuppressed } from "../src/suppression.js";
import { closeDb, resetDb } from "./helpers.js";

let server: Server;
let base = "";

beforeAll(async () => {
  await resetDb();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  server.close();
  await closeDb();
});

let cookie = "";
async function req(path: string, init: { method?: string; form?: Record<string, string>; json?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { cookie, ...(init.headers ?? {}) };
  let body: string | undefined;
  if (init.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(init.form).toString();
  } else if (init.json) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  const res = await fetch(base + path, { method: init.method ?? (body ? "POST" : "GET"), headers, body, redirect: "manual" });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) {
    const jar = new Map(cookie.split("; ").filter(Boolean).map((c) => c.split("=") as [string, string]));
    for (const c of set) {
      const [kv] = c.split(";");
      const [k, ...v] = kv.split("=");
      jar.set(k, v.join("="));
    }
    cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  return res;
}

describe("review app", () => {
  beforeEach(() => { cookie = ""; });

  async function login(role: "admin" | "outreach" = "outreach") {
    const email = `${role}@puretech.test`;
    await query(
      "INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING",
      [email, role === "admin" ? "J" : "Outreach Lead", role, await bcrypt.hash("pw", 4)],
    );
    const res = await req("/login", { form: { email, password: "pw" } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/queue");
  }

  it("requires login", async () => {
    const res = await req("/queue");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^\/login/);
    const bad = await req("/login", { form: { email: "nobody@x.com", password: "x" } });
    expect(bad.headers.get("location")).toBe("/login");
  });

  it("lets the outreach lead approve a draft from the queue", async () => {
    const s = await getSettings();
    const r = await ingestCandidate({ source: "places", placeId: "Q1", businessName: "Queue Cafe", email: "hi@queuecafe.com", category: "restaurant_cafe" }, s);
    const leadId = (r as any).leadId;
    await query("UPDATE leads SET stage = 'drafted', score = 72 WHERE id = $1", [leadId]);
    const body = "Hi Queue Cafe team,\n\nYou don't have a website of your own yet. Could I sketch a simple one for you?" + signatureAndFooter(s, { name: config.senderName });
    const d = await one("INSERT INTO drafts (lead_id, template, subject, body, facts_json) VALUES ($1, 'no_website', 'A site for Queue Cafe', $2, $3) RETURNING id",
      [leadId, body, JSON.stringify({ business_name: "Queue Cafe", measured: { has_website: false }, offer: { founding_client_half_price_setup: false } })]);

    await login();
    const page = await (await req("/queue")).text();
    expect(page).toContain("Queue Cafe");
    expect(page).toContain("No website"); // facts shown beside the draft

    // Removing the footer is blocked.
    const blocked = await req(`/drafts/${d.id}/approve`, { form: { subject: "A site for Queue Cafe", body: "Hi, want a site?" } });
    expect(blocked.status).toBe(302);
    expect((await one("SELECT status FROM drafts WHERE id = $1", [d.id])).status).toBe("pending");

    const edited = body.replace("sketch", "mock up");
    const ok = await req(`/drafts/${d.id}/approve`, { form: { subject: "A site for Queue Cafe", body: edited } });
    expect(ok.status).toBe(302);
    expect((await one("SELECT status, reviewed_by FROM drafts WHERE id = $1", [d.id]))).toEqual({ status: "edited", reviewed_by: "Outreach Lead" });
    expect((await one("SELECT stage FROM leads WHERE id = $1", [leadId])).stage).toBe("approved");
    expect((await one("SELECT body FROM messages")).body).toContain("mock up");

    for (const path of ["/replies", "/walk-in", "/leads", "/scoreboard", `/leads/${leadId}`, "/leads/new"]) {
      const res = await req(path);
      expect(res.status, path).toBe(200);
    }
    expect((await req("/admin")).status).toBe(403);
    const csv = await (await req("/leads.csv")).text();
    expect(csv.split("\n")[0]).toContain("business_name");
    expect(csv).toContain("Queue Cafe");
  });

  it("lets the outreach lead record outcomes and add manual leads", async () => {
    await login();
    const res = await req("/leads/new", { form: { source: "referral", referrer: "Pat the accountant", business_name: "Ref Plumbing", category: "contractor", address: "1 Main St, Bronx, NY 10463", phone: "7185550199" } });
    expect(res.status).toBe(302);
    const lead = await one("SELECT * FROM leads WHERE business_name = 'Ref Plumbing'");
    expect(lead).toBeTruthy();
    expect((await one("SELECT referrer FROM lead_sources WHERE lead_id = $1", [lead.id])).referrer).toBe("Pat the accountant");
    await req(`/leads/${lead.id}/outcome`, { form: { outcome: "call_booked" } });
    expect((await one("SELECT stage FROM leads WHERE id = $1", [lead.id])).stage).toBe("call");
    expect(await one("SELECT * FROM events WHERE type = 'call_booked' AND lead_id = $1", [lead.id])).toBeTruthy();
  });

  it("gives J the admin page and saves settings", async () => {
    await login("admin");
    expect((await req("/admin")).status).toBe(200);
    const s = await getSettings();
    await req("/admin/settings", {
      form: {
        targetZips: "10463, 10471, 10468", neighborhoods: "10463=Kingsbridge\n10471=Riverdale", categories: JSON.stringify(s.categories),
        w_noWebsite: "40", t_draft: "60", t_queue: "40", t_walkIn: "50", chainNames: "dunkin", foundingSlotsLeft: "2",
        windowStart: "09:30", windowEnd: "16:30", spacingMin: "3", spacingMax: "8", mailingAddress: "PO Box 9, Bronx, NY 10463",
        companyName: "PureTech", bannedPhrases: "guaranteed", maxWords: "120", skipThanksgivingWeek: "on", skipLateDecember: "on",
      },
    });
    const after = await getSettings();
    expect(after.targetZips).toEqual(["10463", "10471", "10468"]);
    expect(after.scoring.noWebsite).toBe(40);
    expect(after.foundingSlotsOpen).toBe(false);
    expect(after.mailingAddress).toBe("PO Box 9, Bronx, NY 10463");

    await req("/admin/suppression", { form: { value: "bigclient.com", reason: "client" } });
    expect(await isSuppressed({ website: "https://www.bigclient.com" })).toBe(true);
  });
});

describe("public endpoints", () => {
  it("unsubscribes from the footer link and the one-click header", async () => {
    const s = await getSettings();
    const r = await ingestCandidate({ source: "places", placeId: "U1", businessName: "Unsub Deli", email: "deli@unsub.com" }, s);
    const token = unsubscribeToken((r as any).leadId, "deli@unsub.com");
    const page = await req(`/u/${token}`);
    expect(await page.text()).toContain("deli@unsub.com");
    expect(await isSuppressed({ email: "deli@unsub.com" })).toBe(false); // GET alone doesn't unsubscribe
    const res = await req(`/u/${token}`, { form: { "List-Unsubscribe": "One-Click" } });
    expect(res.status).toBe(200);
    expect(await isSuppressed({ email: "deli@unsub.com" })).toBe(true);
    expect((await one("SELECT stage FROM leads WHERE id = $1", [(r as any).leadId])).stage).toBe("unsubscribed");
    expect((await req("/u/garbage.token")).status).toBe(404);
  });

  it("accepts check-up form submissions with the shared secret", async () => {
    (config as any).formWebhookSecret = "s3cret";
    expect((await req("/hooks/form", { json: { business_name: "Form Co", email: "me@formco.com" } })).status).toBe(401);
    const res = await req("/hooks/form", { json: { business_name: "Form Co", email: "me@formco.com", phone: "718 555 0100", message: "Help with my site", consent: true }, headers: { "x-webhook-secret": "s3cret" } });
    expect(res.status).toBe(202);
    const lead = await one("SELECT * FROM leads WHERE business_name = 'Form Co'");
    expect(lead.priority).toBe(true);
    expect(lead.email).toBe("me@formco.com");
    expect(lead.notes).toContain("Help with my site");
    // Let the background check finish before the pool closes.
    for (let i = 0; i < 50 && !(await one("SELECT 1 FROM checks WHERE lead_id = $1", [lead.id])); i++) await new Promise((r) => setTimeout(r, 50));
  });
});
