import { Router } from "express";
import { config } from "../../config.js";
import { query } from "../../db/pool.js";
import { listTemplates } from "../../draft/templates.js";
import { tracked } from "../../jobs/runs.js";
import { runWeekly, processPending } from "../../jobs/weekly.js";
import { runScheduler, sentSince } from "../../send/scheduler.js";
import { getSettings, setSetting, DEFAULT_SETTINGS, type Settings, type Category } from "../../settings.js";
import { suppressDomain, suppressEmail, type SuppressionReason } from "../../suppression.js";
import { dailyCap, formatLocal, localDateKey, startOfLocalDay } from "../../util/time.js";
import { runWatcher } from "../../watch/watcher.js";
import { flash, page } from "../app.js";
import { html } from "../html.js";

const lines = (s: unknown) => String(s ?? "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
const num = (s: unknown, fallback: number) => (s === undefined || s === "" || Number.isNaN(Number(s)) ? fallback : Number(s));

export function parseSettingsForm(b: Record<string, string>, current: Settings): Partial<Settings> {
  const neighborhoods: Record<string, string> = {};
  for (const l of lines(b.neighborhoods)) {
    const [zip, ...name] = l.split("=");
    if (zip && name.length) neighborhoods[zip.trim()] = name.join("=").trim();
  }
  let categories: Category[] = current.categories;
  try {
    const parsed = JSON.parse(b.categories);
    if (Array.isArray(parsed) && parsed.every((c) => c.key && c.label && c.query)) categories = parsed;
  } catch {
    /* keep current */
  }
  const w = current.scoring;
  return {
    targetZips: String(b.targetZips ?? "").split(/[\s,]+/).filter((z) => /^\d{5}$/.test(z)),
    neighborhoods,
    categories,
    scoring: {
      noWebsite: num(b.w_noWebsite, w.noWebsite), brokenOrNotHttps: num(b.w_brokenOrNotHttps, w.brokenOrNotHttps),
      slowMobile: num(b.w_slowMobile, w.slowMobile), oldCopyright: num(b.w_oldCopyright, w.oldCopyright),
      apptNoBooking: num(b.w_apptNoBooking, w.apptNoBooking), fewReviews: num(b.w_fewReviews, w.fewReviews),
      lowRating: num(b.w_lowRating, w.lowRating), publishedEmail: num(b.w_publishedEmail, w.publishedEmail), chain: num(b.w_chain, w.chain),
    },
    thresholds: {
      draft: num(b.t_draft, current.thresholds.draft), queue: num(b.t_queue, current.thresholds.queue), walkIn: num(b.t_walkIn, current.thresholds.walkIn),
    },
    chainNames: lines(b.chainNames).map((x) => x.toLowerCase()),
    foundingSlotsOpen: b.foundingSlotsOpen === "on",
    foundingSlotsLeft: num(b.foundingSlotsLeft, current.foundingSlotsLeft),
    sendWindow: { start: b.windowStart || current.sendWindow.start, end: b.windowEnd || current.sendWindow.end },
    extraHolidays: lines(b.extraHolidays),
    skipThanksgivingWeek: b.skipThanksgivingWeek === "on",
    skipLateDecember: b.skipLateDecember === "on",
    rampStartDate: b.rampStartDate || null,
    dailyCapOverride: b.dailyCapOverride === "" || b.dailyCapOverride === undefined ? null : num(b.dailyCapOverride, 15),
    spacingMinutes: { min: num(b.spacingMin, 3), max: num(b.spacingMax, 8) },
    mailingAddress: String(b.mailingAddress ?? "").trim(),
    companyName: String(b.companyName ?? current.companyName).trim() || current.companyName,
    senderTitle: String(b.senderTitle ?? "").trim(),
    bannedPhrases: lines(b.bannedPhrases),
    maxWords: num(b.maxWords, current.maxWords),
    notifyOnReply: b.notifyOnReply === "on",
  };
}

export function adminRoutes(): Router {
  const r = Router();

  r.get("/", async (req, res) => {
    const s = await getSettings();
    const [templates, alerts, runs, suppression, users] = await Promise.all([
      listTemplates(),
      query("SELECT * FROM alerts WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 20"),
      query("SELECT DISTINCT ON (job) job, started_at, finished_at, ok, summary FROM job_runs ORDER BY job, started_at DESC"),
      query("SELECT * FROM suppression ORDER BY added_at DESC LIMIT 50"),
      query("SELECT email, name, role FROM users ORDER BY id"),
    ]);
    const firstSent = await query<{ first: Date | null }>("SELECT MIN(sent_at) AS first FROM messages WHERE status = 'sent'");
    const rampStart = s.rampStartDate ?? (firstSent[0].first ? localDateKey(firstSent[0].first) : null);
    const cap = dailyCap(new Date(), rampStart, s.dailyCapOverride);
    const sentToday = await sentSince(startOfLocalDay(new Date()));
    const [deliv] = await query(
      `SELECT (SELECT COUNT(*) FROM messages WHERE status = 'sent' AND sent_at > now() - interval '14 days') AS sent,
              (SELECT COUNT(*) FROM events WHERE type = 'bounce' AND at > now() - interval '14 days') AS bounces,
              (SELECT COUNT(*) FROM suppression WHERE reason = 'complaint' AND added_at > now() - interval '30 days') AS complaints,
              (SELECT COUNT(*) FROM messages WHERE status = 'scheduled') AS queued,
              (SELECT COUNT(*) FROM messages WHERE status = 'failed') AS failed`,
    );
    const w = s.scoring;
    const weight = (key: keyof typeof w, label: string) => html`<div><label>${label}</label><input type="number" name="w_${key}" value="${w[key]}"></div>`;

    page(req, res, "Admin", "/admin", html`
      <h1>Admin</h1>
      <p class="sub">Targets, scoring, templates, compliance, and deliverability. ${config.dryRun ? html`<strong>DRY_RUN is on: nothing is sent.</strong>` : ""}</p>
      ${!s.mailingAddress ? html`<div class="flash error">Set PureTech's mailing address below. Drafts fail validation without it, so nothing can be approved.</div>` : ""}
      ${alerts.length ? html`<div class="card"><strong class="err">Alerts</strong><ul>${alerts.map((a: any) => html`<li>${formatLocal(a.created_at)}: ${a.message}
        <form method="post" action="/admin/alerts/${a.id}/resolve" style="display:inline"><button class="small">Dismiss</button></form></li>`)}</ul></div>` : ""}

      <div class="stats">
        <div class="stat"><div class="n">${sentToday} / ${cap}</div><div class="l">sent today / daily cap${rampStart ? ` (ramp from ${rampStart})` : ""}</div></div>
        <div class="stat"><div class="n">${deliv.queued}</div><div class="l">emails scheduled</div></div>
        <div class="stat"><div class="n">${deliv.sent ? ((deliv.bounces / deliv.sent) * 100).toFixed(1) : "0.0"}%</div><div class="l">bounce rate, 14 days (${deliv.bounces}/${deliv.sent})</div></div>
        <div class="stat"><div class="n">${deliv.complaints}</div><div class="l">spam complaints logged, 30 days</div></div>
        <div class="stat"><div class="n">${deliv.failed}</div><div class="l">failed sends</div></div>
      </div>
      <p class="small muted">Watch spam complaint rate in Google Postmaster Tools for the outreach subdomain and keep it well below 0.3%. Log complaints below so they're suppressed.</p>

      <div class="card"><strong>Run now</strong>
        <form method="post" class="row" style="margin-top:8px">
          <button formaction="/admin/run/weekly">Weekly lead run</button>
          <button formaction="/admin/run/process">Check unchecked leads</button>
          <button formaction="/admin/run/scheduler">Scheduler tick</button>
          <button formaction="/admin/run/watcher">Check for replies</button>
        </form>
        <table style="margin-top:10px"><tr><th>Job</th><th>Last run</th><th>Result</th></tr>
          ${runs.map((j: any) => html`<tr><td>${j.job}</td><td class="small">${formatLocal(j.started_at)}</td>
            <td class="small ${j.ok === false ? "err" : ""}"><code>${JSON.stringify(j.summary ?? {}).slice(0, 300)}</code></td></tr>`)}
        </table></div>

      <form method="post" action="/admin/settings">
        <div class="card"><h2 style="margin-top:0">Targets</h2>
          <label>ZIP codes</label><input type="text" name="targetZips" value="${s.targetZips.join(", ")}">
          <label>Neighborhood names (ZIP=name, one per line)</label>
          <textarea class="short" name="neighborhoods">${Object.entries(s.neighborhoods).map(([z, n]) => `${z}=${n}`).join("\n")}</textarea>
          <label>Categories (JSON: key, label, Places search phrase, appointment business)</label>
          <textarea name="categories">${JSON.stringify(s.categories, null, 2)}</textarea>
          <label>Chain and franchise names (one per line)</label><textarea class="short" name="chainNames">${s.chainNames.join("\n")}</textarea>
        </div>
        <div class="card"><h2 style="margin-top:0">Scoring</h2>
          <div class="stats">
            ${weight("noWebsite", "No website")}${weight("brokenOrNotHttps", "Site broken or not HTTPS")}${weight("slowMobile", "Mobile performance below 50")}
            ${weight("oldCopyright", "Copyright 3+ years old")}${weight("apptNoBooking", "Appointment, no booking")}${weight("fewReviews", "Fewer than 20 reviews")}
            ${weight("lowRating", "Rating below 4.0")}${weight("publishedEmail", "Published email")}${weight("chain", "Chain or franchise")}
          </div>
          <div class="stats">
            <div><label>Draft automatically at</label><input type="number" name="t_draft" value="${s.thresholds.draft}"></div>
            <div><label>Queue without draft at</label><input type="number" name="t_queue" value="${s.thresholds.queue}"></div>
            <div><label>Walk-in (no email) at</label><input type="number" name="t_walkIn" value="${s.thresholds.walkIn}"></div>
          </div>
        </div>
        <div class="card"><h2 style="margin-top:0">Drafting and offer</h2>
          <label class="row"><input type="checkbox" name="foundingSlotsOpen" ${s.foundingSlotsOpen ? "checked" : ""}> Founding-client half-price setup is open</label>
          <label>Founding slots left</label><input type="number" name="foundingSlotsLeft" value="${s.foundingSlotsLeft}">
          <label>Word limit</label><input type="number" name="maxWords" value="${s.maxWords}">
          <label>Banned phrases (one per line)</label><textarea class="short" name="bannedPhrases">${s.bannedPhrases.join("\n")}</textarea>
        </div>
        <div class="card"><h2 style="margin-top:0">Compliance</h2>
          <label>Company name</label><input type="text" name="companyName" value="${s.companyName}">
          <label>Mailing address for the footer (office, registered PO box, or private mailbox)</label><input type="text" name="mailingAddress" value="${s.mailingAddress}">
          <label>Sender title (optional)</label><input type="text" name="senderTitle" value="${s.senderTitle}">
          <p class="small muted">Sender: ${config.senderName || "(SENDER_NAME not set)"} &lt;${config.senderEmail || "SENDER_EMAIL not set"}&gt;</p>
        </div>
        <div class="card"><h2 style="margin-top:0">Sending</h2>
          <div class="stats">
            <div><label>Window start (Eastern)</label><input type="text" name="windowStart" value="${s.sendWindow.start}"></div>
            <div><label>Window end (Eastern)</label><input type="text" name="windowEnd" value="${s.sendWindow.end}"></div>
            <div><label>Spacing min (minutes)</label><input type="number" name="spacingMin" value="${s.spacingMinutes.min}"></div>
            <div><label>Spacing max (minutes)</label><input type="number" name="spacingMax" value="${s.spacingMinutes.max}"></div>
            <div><label>Ramp start date</label><input type="date" name="rampStartDate" value="${s.rampStartDate ?? ""}"></div>
            <div><label>Daily cap override</label><input type="number" name="dailyCapOverride" value="${s.dailyCapOverride ?? ""}" placeholder="ramp: 15/25/40"></div>
          </div>
          <label class="row"><input type="checkbox" name="skipThanksgivingWeek" ${s.skipThanksgivingWeek ? "checked" : ""}> Skip Thanksgiving week</label>
          <label class="row"><input type="checkbox" name="skipLateDecember" ${s.skipLateDecember ? "checked" : ""}> Skip Dec 22–31</label>
          <label>Other days off (YYYY-MM-DD or YYYY-MM-DD..YYYY-MM-DD, one per line)</label><textarea class="short" name="extraHolidays">${s.extraHolidays.join("\n")}</textarea>
          <label class="row"><input type="checkbox" name="notifyOnReply" ${s.notifyOnReply ? "checked" : ""}> Email ${config.replyNotifyEmail || "REPLY_NOTIFY_EMAIL"} when a reply arrives</label>
        </div>
        <p><button class="primary">Save settings</button> <button formaction="/admin/settings/reset" class="danger">Reset to defaults</button></p>
      </form>

      <h2>Templates</h2>
      <p class="small muted">First-email templates steer Claude; follow-ups are pre-approved text. Placeholders: {{business_name}}, {{sender_name}}, {{company}}.</p>
      ${templates.map((t) => html`<form method="post" action="/admin/templates/${t.name}" class="card">
        <strong>${t.name}</strong> <span class="chip">${t.kind}</span>
        <label>${t.kind === "first" ? "Angle for Claude" : "Description"}</label><textarea class="short" name="description">${t.description}</textarea>
        ${t.kind === "followup" ? html`<label>Body (signature and footer are added automatically)</label><textarea name="body">${t.body}</textarea>` : ""}
        <p><button>Save template</button></p></form>`)}

      <h2>Suppression list</h2>
      <p class="small muted">Checked before every send. Entries are permanent.</p>
      <form method="post" action="/admin/suppression" class="card row">
        <input type="text" name="value" placeholder="email@business.com or business.com" style="max-width:320px" required>
        <select name="reason" style="max-width:200px"><option value="client">existing client</option><option value="do_not_contact">do not contact</option>
          <option value="complaint">spam complaint</option><option value="unsubscribe">unsubscribe</option><option value="bounce">bounce</option></select>
        <button>Add</button></form>
      <div class="table-wrap"><table><tr><th>Value</th><th>Reason</th><th>Added</th></tr>
        ${suppression.map((x: any) => html`<tr><td>${x.value}</td><td>${x.reason}</td><td class="small">${formatLocal(x.added_at)}</td></tr>`)}</table></div>

      <h2>Users</h2>
      <ul>${users.map((u: any) => html`<li>${u.name} (${u.email}) · ${u.role}</li>`)}</ul>
      <p class="small muted">Add users with <code>npm run cli -- create-user email name role password</code>.</p>
    `);
  });

  r.post("/settings", async (req, res) => {
    const current = await getSettings();
    const next = parseSettingsForm(req.body, current);
    for (const [k, v] of Object.entries(next)) await setSetting(k as keyof Settings, v as never);
    flash(req, "info", "Settings saved.");
    res.redirect("/admin");
  });

  r.post("/settings/reset", async (req, res) => {
    const current = await getSettings();
    for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      // Keep the compliance details; they have no sensible default.
      if (k === "mailingAddress" || k === "senderTitle" || k === "rampStartDate") continue;
      await setSetting(k, DEFAULT_SETTINGS[k] as never);
    }
    await setSetting("mailingAddress", current.mailingAddress);
    flash(req, "info", "Settings reset to defaults (mailing address kept).");
    res.redirect("/admin");
  });

  r.post("/templates/:name", async (req, res) => {
    await query(
      "UPDATE templates SET description = $2, body = COALESCE($3, body), updated_at = now() WHERE name = $1",
      [req.params.name, String(req.body.description ?? ""), req.body.body !== undefined ? String(req.body.body).replace(/\r\n/g, "\n") : null],
    );
    flash(req, "info", `Template ${req.params.name} saved.`);
    res.redirect("/admin");
  });

  r.post("/suppression", async (req, res) => {
    const value = String(req.body.value ?? "").trim().toLowerCase();
    const reason = String(req.body.reason) as SuppressionReason;
    if (value.includes("@")) await suppressEmail(value, reason);
    else await suppressDomain(value, reason);
    // Suppressing an address stops any sequence already running to it.
    await query(
      `UPDATE messages SET status = 'cancelled', last_error = 'suppressed'
       WHERE status = 'scheduled' AND (lower(to_email) = $1 OR split_part(lower(to_email), '@', 2) = $1)`,
      [value],
    );
    flash(req, "info", `${value} added to suppression.`);
    res.redirect("/admin");
  });

  r.post("/alerts/:id/resolve", async (req, res) => {
    await query("UPDATE alerts SET resolved_at = now() WHERE id = $1", [Number(req.params.id)]);
    res.redirect("/admin");
  });

  r.post("/run/:job", async (req, res) => {
    const jobs: Record<string, () => Promise<unknown>> = {
      weekly: () => runWeekly(),
      process: () => processPending(),
      scheduler: () => runScheduler({ tickMs: 60_000 }),
      watcher: () => runWatcher(),
    };
    const fn = jobs[req.params.job];
    if (!fn) return res.status(404).send("Unknown job");
    if (req.params.job === "weekly") {
      // The weekly run can take a while; run it in the background.
      tracked("weekly", fn).catch((err) => console.error("weekly run failed", err));
      flash(req, "info", "Weekly run started. Refresh this page to see its result.");
    } else {
      const result = await tracked(req.params.job, fn);
      flash(req, "info", `${req.params.job}: ${JSON.stringify(result)}`);
    }
    res.redirect("/admin");
  });

  return r;
}
