import { Router } from "express";
import { one, query } from "../../db/pool.js";
import { recordEvent } from "../../events.js";
import { ingestCandidate } from "../../pipeline/ingest.js";
import { processLead } from "../../pipeline/process.js";
import { recordManualOutcome, ReviewError, type ManualOutcome } from "../../send/sequence.js";
import { getSettings } from "../../settings.js";
import { formatLocal } from "../../util/time.js";
import { formatPhone, normalizeEmail, normalizePhone, streetOf } from "../../util/normalize.js";
import { flash, page } from "../app.js";
import { html, stageChip } from "../html.js";

const STAGES = ["new", "qualified", "drafted", "approved", "contacted", "replied", "call", "proposal", "signed", "paid", "lost", "unsubscribed", "bounced"];

const OUTCOMES: [ManualOutcome, string][] = [
  ["replied", "Mark replied"],
  ["call_booked", "Call booked"],
  ["proposal_sent", "Proposal sent"],
  ["signed", "Signed"],
  ["paid", "Paid"],
  ["not_interested", "Not interested"],
  ["do_not_contact", "Do not contact"],
];

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v);
  // Neutralize spreadsheet formulas in exported text.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function leadRoutes(): Router {
  const r = Router();

  // The tracker: every lead, filterable by stage.
  r.get("/leads", async (req, res) => {
    const stage = STAGES.includes(String(req.query.stage)) ? String(req.query.stage) : null;
    const q = String(req.query.q ?? "").trim();
    const showArchived = req.query.archived === "1";
    const rows = await query<{
      id: number; business_name: string; category: string | null; stage: string; score: number | null; email: string | null;
      phone: string | null; next_action: string | null; next_action_at: Date | null; updated_at: Date; sources: string[]; archived_at: Date | null;
    }>(
      `SELECT l.*, ARRAY(SELECT DISTINCT source FROM lead_sources s WHERE s.lead_id = l.id) AS sources FROM leads l
       WHERE ($1::text IS NULL OR l.stage = $1) AND ($2 = '' OR l.business_name ILIKE '%' || $2 || '%' OR l.email ILIKE '%' || $2 || '%')
         AND ($3 OR l.archived_at IS NULL)
       ORDER BY l.updated_at DESC LIMIT 500`,
      [stage, q, showArchived],
    );
    const counts = await query<{ stage: string; n: number }>("SELECT stage, COUNT(*) AS n FROM leads WHERE archived_at IS NULL GROUP BY stage");
    const countOf = (s: string) => counts.find((c) => c.stage === s)?.n ?? 0;
    page(req, res, "Tracker", "/leads", html`
      <div class="row" style="justify-content:space-between"><h1>Tracker</h1>
        <div class="row"><a class="btn" href="/leads/new">Add a lead</a><a class="btn" href="/leads.csv">Export CSV</a></div></div>
      <p class="row small">${STAGES.map((s) => html`<a class="chip" href="/leads?stage=${s}">${s} ${countOf(s)}</a>`)} <a class="chip" href="/leads">all</a></p>
      <form class="row noprint" method="get" action="/leads" style="margin-bottom:12px">
        ${stage ? html`<input type="hidden" name="stage" value="${stage}">` : ""}
        <input type="text" name="q" value="${q}" placeholder="Search name or email" style="max-width:280px">
        <label class="row small" style="margin:0"><input type="checkbox" name="archived" value="1" ${showArchived ? "checked" : ""}> include archived</label>
        <button>Search</button></form>
      <div class="table-wrap"><table>
        <tr><th>Business</th><th>Stage</th><th class="num">Score</th><th>Contact</th><th>Next action</th><th>Sources</th><th>Updated</th></tr>
        ${rows.map((l) => html`<tr>
          <td><a href="/leads/${l.id}">${l.business_name}</a><div class="small muted">${l.category ?? ""}</div></td>
          <td>${stageChip(l.stage)}${l.archived_at ? html` <span class="chip">archived</span>` : ""}</td>
          <td class="num">${l.score ?? ""}</td>
          <td class="small">${l.email ?? ""}<br>${formatPhone(l.phone)}</td>
          <td class="small">${l.next_action ?? ""}${l.next_action_at ? html`<br><span class="muted">${formatLocal(l.next_action_at)}</span>` : ""}</td>
          <td class="small">${l.sources.join(", ")}</td>
          <td class="small muted">${formatLocal(l.updated_at)}</td></tr>`)}
      </table></div>`);
  });

  // CSV export feeds the existing outreach tracker.
  r.get("/leads.csv", async (_req, res) => {
    const rows = await query(
      `SELECT l.id, l.business_name, l.category, l.address, l.zip, l.phone, l.website, l.email, l.stage, l.score, l.fit,
              l.owner, l.next_action, l.next_action_at, l.created_at, l.updated_at,
              (SELECT string_agg(DISTINCT source, ';') FROM lead_sources s WHERE s.lead_id = l.id) AS sources,
              (SELECT string_agg(DISTINCT referrer, ';') FROM lead_sources s WHERE s.lead_id = l.id AND referrer IS NOT NULL) AS referrers,
              (SELECT MIN(first_seen_at) FROM lead_sources s WHERE s.lead_id = l.id) AS first_seen_at,
              (SELECT MAX(sent_at) FROM messages m JOIN enrollments e ON e.id = m.enrollment_id WHERE e.lead_id = l.id) AS last_sent_at
       FROM leads l WHERE l.archived_at IS NULL ORDER BY l.id`,
    );
    const cols = rows.length ? Object.keys(rows[0]) : ["id"];
    const lines = [cols.join(","), ...rows.map((row) => cols.map((c) => csvCell(row[c])).join(","))];
    res.type("text/csv").set("Content-Disposition", `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`).send(lines.join("\n"));
  });

  r.get("/leads/new", async (req, res) => {
    const settings = await getSettings();
    page(req, res, "Add a lead", "/leads", html`<h1>Add a lead</h1>
      <p class="sub">For businesses found while walking or browsing, and named introductions from referral partners. Only enter an email the business publishes or gave you.</p>
      <form method="post" action="/leads/new" class="card" style="max-width:640px">
        <label>Source</label><select name="source"><option value="manual">Manual add</option><option value="referral">Referral partner</option></select>
        <label>Referrer (for the $250 payout)</label><input type="text" name="referrer">
        <label>Business name</label><input type="text" name="business_name" required>
        <label>Category</label><select name="category"><option value="">–</option>${settings.categories.map((c) => html`<option value="${c.key}">${c.label}</option>`)}</select>
        <label>Address</label><input type="text" name="address" placeholder="123 W 238th St, Bronx, NY 10463">
        <label>Phone</label><input type="text" name="phone">
        <label>Website</label><input type="url" name="website">
        <label>Email</label><input type="email" name="email">
        <label>Notes</label><textarea class="short" name="notes"></textarea>
        <p><button class="primary">Add and check</button></p>
      </form>`);
  });

  r.post("/leads/new", async (req, res) => {
    const settings = await getSettings();
    const b = req.body;
    const source = b.source === "referral" ? "referral" : "manual";
    const outcome = await ingestCandidate(
      {
        source, sourceRef: `${source}-${Date.now()}`, referrer: b.referrer || null, businessName: String(b.business_name ?? ""),
        category: b.category || null, address: b.address || null, phone: b.phone || null, website: b.website || null,
        email: b.email || null, notes: b.notes || null,
      },
      settings,
    );
    if (outcome.status === "skipped") {
      flash(req, "error", `Not added: ${outcome.reason === "suppressed" ? "it matches the opt-out or client list" : outcome.reason}`);
      return res.redirect("/leads/new");
    }
    try {
      await processLead(outcome.leadId, { draft: !!process.env.ANTHROPIC_API_KEY });
    } catch (err) {
      flash(req, "error", `Added, but checks failed: ${(err as Error).message}`);
      return res.redirect(`/leads/${outcome.leadId}`);
    }
    flash(req, "info", outcome.status === "merged" ? "That business was already a lead; merged the details." : "Lead added and checked.");
    res.redirect(`/leads/${outcome.leadId}`);
  });

  r.get("/leads/:id", async (req, res) => {
    const id = Number(req.params.id);
    const lead = await one("SELECT * FROM leads WHERE id = $1", [id]);
    if (!lead) return res.status(404).send("Lead not found");
    const [sources, checks, drafts, messages, events, inbound] = await Promise.all([
      query("SELECT * FROM lead_sources WHERE lead_id = $1 ORDER BY first_seen_at", [id]),
      query("SELECT * FROM checks WHERE lead_id = $1 ORDER BY ran_at DESC LIMIT 3", [id]),
      query("SELECT * FROM drafts WHERE lead_id = $1 ORDER BY created_at DESC", [id]),
      query(`SELECT m.* FROM messages m JOIN enrollments e ON e.id = m.enrollment_id WHERE e.lead_id = $1 ORDER BY m.scheduled_at`, [id]),
      query("SELECT * FROM events WHERE lead_id = $1 ORDER BY at DESC LIMIT 50", [id]),
      query("SELECT * FROM inbound WHERE lead_id = $1 ORDER BY received_at DESC", [id]),
    ]);
    const c = checks[0];
    page(req, res, lead.business_name, "/leads", html`
      <div class="row" style="justify-content:space-between">
        <div><h1>${lead.business_name}</h1>
          <p class="sub">${stageChip(lead.stage)} ${lead.is_chain ? html`<span class="chip bad">chain</span>` : ""}
            ${lead.walk_in ? html`<span class="chip">walk-in</span>` : ""} ${lead.archived_at ? html`<span class="chip">archived</span>` : ""}
            ${lead.fit ? html`<span class="chip">${lead.fit} fit</span>` : ""}</p></div>
        <div class="score">${lead.score ?? "–"}</div>
      </div>
      <div class="grid">
        <div>
          <div class="card">
            <form method="post" action="/leads/${id}/update">
              <div class="row" style="gap:16px">
                <div style="flex:1;min-width:200px"><label>Email</label><input type="email" name="email" value="${lead.email ?? ""}"></div>
                <div style="flex:1;min-width:160px"><label>Phone</label><input type="text" name="phone" value="${formatPhone(lead.phone)}"></div>
                <div style="flex:1;min-width:140px"><label>Owner</label><input type="text" name="owner" value="${lead.owner ?? ""}"></div>
              </div>
              <label>Notes</label><textarea class="short" name="notes">${lead.notes ?? ""}</textarea>
              <p><button>Save</button></p>
            </form>
            <div class="small muted">${lead.address ?? ""} ${lead.website ? html` · <a href="${lead.website}" target="_blank" rel="noopener">${lead.website}</a>` : ""}</div>
          </div>
          <h2>Messages</h2>
          ${messages.length === 0 ? html`<p class="muted">Nothing scheduled.</p>` : messages.map((m: any) => html`<div class="card">
            <div class="row small"><strong>Step ${m.step}</strong> <span class="chip">${m.status}</span>
              <span class="muted">${m.sent_at ? `sent ${formatLocal(m.sent_at)}` : `scheduled ${formatLocal(m.scheduled_at)}`}</span>
              ${m.last_error ? html`<span class="err">${m.last_error}</span>` : ""}</div>
            <details><summary>${m.subject}</summary><pre class="mail">${m.body}</pre></details></div>`)}
          ${inbound.length ? html`<h2>Inbound</h2>${inbound.map((m: any) => html`<div class="card small"><strong>${m.classification}</strong>
            <span class="muted">${formatLocal(m.received_at)} · ${m.from_email}</span><pre class="mail">${m.snippet}</pre></div>`)}` : ""}
          <h2>Drafts</h2>
          ${drafts.length === 0 ? html`<p class="muted">No drafts.</p>` : drafts.map((d: any) => html`<div class="card small">
            <span class="chip">${d.status}</span> ${d.template} · ${formatLocal(d.created_at)} ${d.reject_reason ? html`· <span class="muted">${d.reject_reason}</span>` : ""}
            <details><summary>${d.subject || "(no subject)"}</summary><pre class="mail">${d.body}</pre></details></div>`)}
        </div>
        <div>
          <div class="card">
            <strong>Outcome</strong>
            <form method="post" action="/leads/${id}/outcome" class="row" style="margin-top:8px">
              ${OUTCOMES.map(([v, label]) => html`<button name="outcome" value="${v}">${label}</button>`)}
            </form>
            <div class="row" style="margin-top:10px">
              ${lead.email ? html`<form method="post" action="/leads/${id}/draft"><button>Write a draft</button></form>` : ""}
              ${!lead.walk_in && lead.walk_in_allowed ? html`<form method="post" action="/leads/${id}/walk-in"><button>Add to walk-in</button></form>` : ""}
              <form method="post" action="/leads/${id}/recheck"><button>Re-run checks</button></form>
            </div>
          </div>
          <div class="card small">
            <strong>Latest checks</strong> ${c ? html`<span class="muted">${formatLocal(c.ran_at)}</span>` : ""}
            ${c ? html`<ul class="facts">
              <li>Website: ${!c.has_site ? "none" : c.https_ok ? "loads on HTTPS"
                : c.http_status && c.http_status < 400 ? "loads, but not on HTTPS" : `broken (${c.http_status ? `HTTP ${c.http_status}` : "no response"})`}</li>
              ${c.mobile_score !== null ? html`<li>Mobile performance: ${c.mobile_score}</li>` : ""}
              ${c.has_viewport !== null ? html`<li>Viewport tag: ${c.has_viewport ? "yes" : "no"}</li>` : ""}
              ${c.copyright_year ? html`<li>Copyright year: ${c.copyright_year}</li>` : ""}
              ${c.has_booking !== null ? html`<li>Online booking: ${c.has_booking ? "yes" : "no"}</li>` : ""}
              ${c.review_count !== null ? html`<li>Google: ${c.review_count} reviews, rating ${c.rating ?? "–"}</li>` : ""}
              <li>Published email: ${c.published_email ?? "none found"}</li></ul>` : html`<p class="muted">Not checked yet.</p>`}
            ${lead.score_breakdown ? html`<strong>Score</strong><ul class="facts">${lead.score_breakdown.map((l: any) => html`<li>${l.signal}: ${l.points > 0 ? "+" : ""}${l.points}</li>`)}</ul>` : ""}
          </div>
          <div class="card small"><strong>Sources</strong><ul class="facts">${sources.map((s: any) => html`<li>${s.source}${s.referrer ? ` (referred by ${s.referrer})` : ""} · ${formatLocal(s.first_seen_at)}</li>`)}</ul></div>
          <div class="card small"><strong>History</strong><ul class="facts">${events.map((e: any) => html`<li>${e.type} <span class="muted">${formatLocal(e.at)}</span></li>`)}</ul></div>
        </div>
      </div>`);
  });

  r.post("/leads/:id/update", async (req, res) => {
    const id = Number(req.params.id);
    const email = req.body.email ? normalizeEmail(req.body.email) : null;
    if (req.body.email && !email) {
      flash(req, "error", "That email address doesn't look valid.");
      return res.redirect(`/leads/${id}`);
    }
    await query(
      "UPDATE leads SET email = $2, phone = $3, owner = $4, notes = $5, updated_at = now() WHERE id = $1",
      [id, email, normalizePhone(req.body.phone) ?? (req.body.phone || null), req.body.owner || null, req.body.notes || null],
    );
    flash(req, "info", "Saved.");
    res.redirect(`/leads/${id}`);
  });

  r.post("/leads/:id/outcome", async (req, res) => {
    const id = Number(req.params.id);
    const outcome = String(req.body.outcome) as ManualOutcome;
    if (!OUTCOMES.some(([v]) => v === outcome)) return res.status(400).send("Unknown outcome");
    try {
      await recordManualOutcome(id, outcome, req.user!.name);
      flash(req, "info", "Updated. Any scheduled emails for this lead are cancelled.");
    } catch (err) {
      if (!(err instanceof ReviewError)) throw err;
      flash(req, "error", err.message);
    }
    res.redirect(`/leads/${id}`);
  });

  r.post("/leads/:id/recheck", async (req, res) => {
    const id = Number(req.params.id);
    const out = await processLead(id, { draft: false });
    flash(req, "info", `Checked: score ${out.score} (${out.disposition}).`);
    res.redirect(`/leads/${id}`);
  });

  // Walk-in route: high-scoring leads with no email, grouped by street.
  r.get("/walk-in", async (req, res) => {
    const rows = await query<{ id: number; business_name: string; address: string | null; phone: string | null; score: number | null; category: string | null; walk_in_visited_at: Date | null; zip: string | null }>(
      `SELECT id, business_name, address, phone, score, category, walk_in_visited_at, zip FROM leads
       WHERE walk_in AND walk_in_allowed AND archived_at IS NULL AND stage IN ('new', 'qualified', 'drafted', 'contacted')
       ORDER BY zip, address`,
    );
    const groups = new Map<string, (typeof rows[number] & { number: number })[]>();
    for (const row of rows) {
      const { street, number } = streetOf(row.address);
      const key = `${row.zip ?? ""} · ${street}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push({ ...row, number });
    }
    const sorted = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
    page(req, res, "Walk-in route", "/walk-in", html`
      <div class="row" style="justify-content:space-between"><h1>Walk-in route</h1><button class="noprint" onclick="window.print()">Print</button></div>
      <p class="sub">${rows.length} businesses on ${sorted.length} streets · no published email, score 50+ · filing-only leads are never listed</p>
      ${sorted.map(([street, items]) => html`<div class="card"><h2 style="margin-top:0">${street}</h2>
        <table><tr><th>#</th><th>Business</th><th>Phone</th><th class="num">Score</th><th class="noprint"></th></tr>
        ${items.sort((a, b) => a.number - b.number).map((l) => html`<tr>
          <td>${l.number || ""}</td>
          <td><a href="/leads/${l.id}">${l.business_name}</a><div class="small muted">${l.category ?? ""}${l.walk_in_visited_at ? ` · visited ${formatLocal(l.walk_in_visited_at)}` : ""}</div></td>
          <td class="small">${formatPhone(l.phone)}</td><td class="num">${l.score ?? ""}</td>
          <td class="noprint"><form method="post" action="/leads/${l.id}/visited"><button class="small">Visited</button></form></td></tr>`)}
        </table></div>`)}`);
  });

  r.post("/leads/:id/visited", async (req, res) => {
    const id = Number(req.params.id);
    await query("UPDATE leads SET walk_in_visited_at = now(), walk_in = false, stage = CASE WHEN stage IN ('new', 'qualified') THEN 'contacted' ELSE stage END, updated_at = now() WHERE id = $1", [id]);
    await recordEvent(id, "walk_in_visit", { by: req.user!.name });
    res.redirect("/walk-in");
  });

  return r;
}
