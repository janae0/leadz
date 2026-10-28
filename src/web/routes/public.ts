import express, { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import { config } from "../../config.js";
import { one } from "../../db/pool.js";
import { ingestCandidate } from "../../pipeline/ingest.js";
import { processLead } from "../../pipeline/process.js";
import { readUnsubscribeToken } from "../../send/mime.js";
import { getSettings } from "../../settings.js";
import { normalizeEmail } from "../../util/normalize.js";
import { unsubscribeLead } from "../../watch/watcher.js";
import { html, layout } from "../html.js";

function simplePage(title: string, body: ReturnType<typeof html>): string {
  return layout({ title, body: html`<div class="card" style="max-width:520px;margin:60px auto">${body}</div>` });
}

function secretMatches(given: string | undefined): boolean {
  if (!config.formWebhookSecret || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(config.formWebhookSecret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function publicRoutes(): Router {
  const r = Router();

  // Opt-out link from the email footer. The link works indefinitely. GET shows
  // a confirmation button so link scanners can't unsubscribe people by accident;
  // POST is also the RFC 8058 one-click target of the List-Unsubscribe header.
  r.get("/u/:token", async (req, res) => {
    const t = readUnsubscribeToken(req.params.token);
    if (!t) return res.status(404).type("html").send(simplePage("Link not recognized", html`<h1>This link isn't valid</h1><p>Reply "stop" to any of our emails and we'll remove you.</p>`));
    const settings = await getSettings();
    res.type("html").send(simplePage("Unsubscribe", html`<h1>Unsubscribe</h1>
      <p>Stop all emails from ${settings.companyName} to <strong>${t.email}</strong>?</p>
      <form method="post"><button class="primary">Unsubscribe</button></form>`));
  });

  r.post("/u/:token", express.urlencoded({ extended: false }), async (req, res) => {
    const t = readUnsubscribeToken(req.params.token);
    if (!t) return res.status(404).send("Not found");
    const lead = await one<{ id: number }>("SELECT id FROM leads WHERE id = $1", [t.leadId]);
    const oneClick = req.body?.["List-Unsubscribe"] === "One-Click";
    await unsubscribeLead(lead?.id ?? null, t.email, oneClick ? "one-click header" : "footer link");
    if (oneClick) return res.status(200).send("Unsubscribed");
    const settings = await getSettings();
    res.type("html").send(simplePage("Unsubscribed", html`<h1>You're unsubscribed</h1>
      <p>${t.email} won't get any more emails from ${settings.companyName}. Sorry for the bother.</p>`));
  });

  // PureTech website check-up form. Highest-intent source: skips scoring and
  // goes straight to the top of the queue.
  r.post("/hooks/form", express.json({ limit: "50kb" }), express.urlencoded({ extended: false }), async (req, res) => {
    if (!secretMatches(req.get("x-webhook-secret") ?? (req.query.key as string | undefined))) {
      return res.status(401).json({ error: "bad secret" });
    }
    const b = req.body ?? {};
    const businessName = String(b.business_name ?? b.businessName ?? "").trim();
    const email = normalizeEmail(b.email);
    if (!businessName || !email) return res.status(400).json({ error: "business_name and email are required" });
    if (b.consent !== undefined && !["true", "yes", "on", "1", true].includes(b.consent)) {
      return res.status(400).json({ error: "consent is required" });
    }
    const settings = await getSettings();
    const outcome = await ingestCandidate(
      {
        source: "form",
        sourceRef: String(b.submission_id ?? b.id ?? new Date().toISOString()),
        businessName,
        email,
        phone: b.phone ? String(b.phone) : null,
        website: b.website ? String(b.website) : null,
        address: b.address ? String(b.address) : null,
        category: b.category ? String(b.category) : null,
        notes: b.message ? `Form message: ${String(b.message).slice(0, 2000)}` : null,
      },
      settings,
    );
    if (outcome.status === "skipped") return res.status(200).json({ ok: true, skipped: outcome.reason });
    res.status(202).json({ ok: true, leadId: outcome.leadId });
    // Check and draft in the background; the response doesn't wait on it.
    processLead(outcome.leadId, { draft: !!process.env.ANTHROPIC_API_KEY }).catch((err) =>
      console.error(`Processing form lead ${outcome.leadId} failed:`, err),
    );
  });

  r.get("/healthz", (_req, res) => res.json({ ok: true }));
  return r;
}
