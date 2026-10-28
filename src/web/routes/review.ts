import { Router } from "express";
import { config } from "../../config.js";
import { query } from "../../db/pool.js";
import { generateDraft } from "../../draft/drafter.js";
import { factLines, type Facts } from "../../draft/facts.js";
import { signatureAndFooter } from "../../draft/templates.js";
import { validateDraft } from "../../draft/validator.js";
import { approveDraft, moveToWalkIn, rejectDraft, ReviewError } from "../../send/sequence.js";
import { getSettings } from "../../settings.js";
import { formatPhone } from "../../util/normalize.js";
import { flash, page } from "../app.js";
import { html } from "../html.js";

const REJECT_REASONS = [
  "Wrong facts", "Wrong business or category", "Tone or wording", "Not a fit for PureTech", "Chain or franchise",
  "Already a client or in talks", "Closed or moved",
];

// Failures that block approval even after a human edit: compliance, not style.
const BLOCKING = /footer|mailing address|postal address|unsubscribe|reply stop|"re:"|banned phrase|subject is empty/i;

interface QueueRow {
  draft_id: number;
  lead_id: number;
  subject: string;
  body: string;
  facts_json: Facts;
  template: string;
  needs_manual: boolean;
  validation_errors: string[] | null;
  business_name: string;
  category: string | null;
  address: string | null;
  phone: string | null;
  website: string | null;
  email: string | null;
  score: number | null;
  priority: boolean;
  score_breakdown: { signal: string; points: number }[] | null;
  sources: string[];
}

export function reviewRoutes(): Router {
  const r = Router();

  r.get("/queue", async (req, res) => {
    const settings = await getSettings();
    const categoryLabel = (key: string | null) => settings.categories.find((c) => c.key === key)?.label ?? key;
    const drafts = await query<QueueRow>(
      `SELECT d.id AS draft_id, d.lead_id, d.subject, d.body, d.facts_json, d.template, d.needs_manual, d.validation_errors,
              l.business_name, l.category, l.address, l.phone, l.website, l.email, l.score, l.priority, l.score_breakdown,
              ARRAY(SELECT DISTINCT source FROM lead_sources s WHERE s.lead_id = l.id) AS sources
       FROM drafts d JOIN leads l ON l.id = d.lead_id
       WHERE d.status = 'pending' AND l.stage = 'drafted'
       ORDER BY l.priority DESC, l.score DESC NULLS LAST, d.created_at
       LIMIT 50`,
    );
    const undrafted = await query<{ id: number; business_name: string; score: number; email: string; category: string | null }>(
      `SELECT l.id, l.business_name, l.score, l.email, l.category FROM leads l
       WHERE l.stage = 'qualified' AND l.email IS NOT NULL AND l.archived_at IS NULL AND NOT l.walk_in
         AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.lead_id = l.id AND d.status = 'pending')
       ORDER BY l.priority DESC, l.score DESC NULLS LAST LIMIT 100`,
    );
    const approvedToday = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM drafts WHERE status IN ('approved', 'edited') AND reviewed_at >= date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1`,
      [config.timezone],
    );

    page(req, res, "Review queue", "/queue", html`
      <h1>Review queue</h1>
      <p class="sub">${drafts.length} drafts waiting · ${approvedToday[0].n} approved today · sorted by score, form requests first</p>
      ${drafts.length === 0 ? html`<div class="card muted">No drafts waiting. New leads arrive with the weekly run.</div>` : ""}
      ${drafts.map((d) => html`
        <div class="card" id="d${d.draft_id}">
          <div class="row" style="justify-content:space-between">
            <div>
              <strong><a href="/leads/${d.lead_id}">${d.business_name}</a></strong>
              ${d.priority ? html`<span class="chip good">form request</span>` : ""}
              ${d.sources.map((s) => html` <span class="chip">${s}</span>`)}
              <div class="small muted">${[categoryLabel(d.category), d.address, formatPhone(d.phone)].filter(Boolean).join(" · ")}</div>
              <div class="small">To: ${d.email} ${d.website ? html` · <a href="${d.website}" target="_blank" rel="noopener">site</a>` : ""}</div>
            </div>
            <div class="score">${d.score ?? "–"}</div>
          </div>
          <div class="grid" style="margin-top:10px">
            <form method="post" action="/drafts/${d.draft_id}/approve">
              ${d.needs_manual ? html`<p class="err small"><strong>Needs manual writing.</strong> The draft failed checks twice:</p>
                <ul class="err small">${(d.validation_errors ?? []).map((e) => html`<li>${e}</li>`)}</ul>` : ""}
              <label>Subject</label><input type="text" name="subject" value="${d.subject}" required>
              <label>Body</label><textarea name="body" required>${d.body}</textarea>
              <div class="row" style="margin-top:10px">
                <button class="primary">Approve and schedule</button>
                <span class="small muted">Edits are checked for the footer and banned phrases before scheduling.</span>
              </div>
            </form>
            <div>
              <div class="small muted">Facts the draft may use</div>
              <ul class="facts">${factLines(d.facts_json).map((l) => html`<li>${l}</li>`)}</ul>
              ${d.facts_json.neighborhood ? html`<div class="small muted" style="margin-top:6px">Neighborhood: ${d.facts_json.neighborhood}</div>` : ""}
              <details style="margin-top:8px"><summary class="small">Score breakdown</summary>
                <ul class="facts small">${(d.score_breakdown ?? []).map((l) => html`<li>${l.signal}: ${l.points > 0 ? "+" : ""}${l.points}</li>`)}</ul>
              </details>
              <form method="post" action="/drafts/${d.draft_id}/reject" style="margin-top:12px">
                <label>Reject with a reason</label>
                <select name="reason">${REJECT_REASONS.map((x) => html`<option>${x}</option>`)}</select>
                <input type="text" name="note" placeholder="Optional note" style="margin-top:6px">
                <p class="row"><button class="danger">Reject</button>
                  <button formaction="/drafts/${d.draft_id}/redraft" title="Write a fresh draft">Redraft</button></p>
              </form>
              <form method="post" action="/leads/${d.lead_id}/walk-in"><button>Move to walk-in list</button></form>
            </div>
          </div>
        </div>`)}
      <h2>Qualified, no draft yet (score 40–59)</h2>
      ${undrafted.length === 0 ? html`<p class="muted">None.</p>` : html`<div class="table-wrap"><table>
        <tr><th>Business</th><th>Category</th><th class="num">Score</th><th></th></tr>
        ${undrafted.map((l) => html`<tr><td><a href="/leads/${l.id}">${l.business_name}</a></td><td>${categoryLabel(l.category) ?? ""}</td>
          <td class="num">${l.score}</td>
          <td><form method="post" action="/leads/${l.id}/draft"><button>Request draft</button></form></td></tr>`)}
      </table></div>`}
    `);
  });

  r.post("/drafts/:id/approve", async (req, res) => {
    const id = Number(req.params.id);
    const subject = String(req.body.subject ?? "").trim();
    const body = String(req.body.body ?? "").replace(/\r\n/g, "\n");
    const [d] = await query<{ facts_json: Facts }>("SELECT facts_json FROM drafts WHERE id = $1", [id]);
    if (!d) return res.status(404).send("Draft not found");
    const settings = await getSettings();
    const signature = signatureAndFooter(settings, { name: config.senderName }).split("\n\n-- \n")[0];
    const v = validateDraft({ subject, body }, d.facts_json, settings, { signature });
    const blocking = v.errors.filter((e) => BLOCKING.test(e));
    if (blocking.length) {
      flash(req, "error", `Not scheduled: ${blocking.join("; ")}`);
      return res.redirect(`/queue#d${id}`);
    }
    try {
      await approveDraft(id, req.user!.name, { subject, body });
      const warnings = v.errors.filter((e) => !BLOCKING.test(e));
      flash(req, "info", warnings.length ? `Approved. Heads-up: ${warnings.join("; ")}` : "Approved and scheduled.");
    } catch (err) {
      if (!(err instanceof ReviewError)) throw err;
      flash(req, "error", err.message);
    }
    res.redirect("/queue");
  });

  r.post("/drafts/:id/reject", async (req, res) => {
    const reason = [req.body.reason, req.body.note].filter(Boolean).join(": ");
    try {
      await rejectDraft(Number(req.params.id), req.user!.name, reason || "No reason given");
      flash(req, "info", "Rejected.");
    } catch (err) {
      if (!(err instanceof ReviewError)) throw err;
      flash(req, "error", err.message);
    }
    res.redirect("/queue");
  });

  r.post("/drafts/:id/redraft", async (req, res) => {
    const [d] = await query<{ lead_id: number }>("SELECT lead_id FROM drafts WHERE id = $1 AND status = 'pending'", [Number(req.params.id)]);
    if (!d) return res.redirect("/queue");
    const out = await generateDraft(d.lead_id);
    flash(req, out.ok ? "info" : "error", out.ok ? "New draft written." : `New draft needs manual writing: ${out.errors.join("; ")}`);
    res.redirect(`/queue#d${out.draftId}`);
  });

  r.post("/leads/:id/draft", async (req, res) => {
    const out = await generateDraft(Number(req.params.id));
    flash(req, out.ok ? "info" : "error", out.ok ? "Draft written and added to the queue." : `Draft needs manual writing: ${out.errors.join("; ")}`);
    res.redirect(`/queue#d${out.draftId}`);
  });

  r.post("/leads/:id/walk-in", async (req, res) => {
    await moveToWalkIn(Number(req.params.id));
    flash(req, "info", "Moved to the walk-in list.");
    res.redirect(req.get("referer")?.includes("/leads/") ? `/leads/${req.params.id}` : "/queue");
  });

  return r;
}
