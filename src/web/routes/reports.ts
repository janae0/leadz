import { Router } from "express";
import { query } from "../../db/pool.js";
import { addDays, formatLocal, startOfLocalWeek } from "../../util/time.js";
import { page } from "../app.js";
import { html } from "../html.js";

export interface WeekStats {
  weekStart: Date;
  newLeads: number;
  contacted: number; // first emails sent
  followups: number;
  replies: number;
  calls: number;
  proposals: number;
  signed: number;
  paid: number;
  bounces: number;
  unsubscribes: number;
  walkIns: number;
}

export async function weekStats(weekStart: Date): Promise<WeekStats> {
  const end = addDays(weekStart, 7);
  const [row] = await query(
    `SELECT
       (SELECT COUNT(*) FROM leads WHERE created_at >= $1 AND created_at < $2) AS new_leads,
       (SELECT COUNT(*) FROM messages WHERE status = 'sent' AND step = 1 AND sent_at >= $1 AND sent_at < $2) AS contacted,
       (SELECT COUNT(*) FROM messages WHERE status = 'sent' AND step > 1 AND sent_at >= $1 AND sent_at < $2) AS followups,
       (SELECT COUNT(*) FROM events WHERE type = 'reply' AND at >= $1 AND at < $2) AS replies,
       (SELECT COUNT(*) FROM events WHERE type = 'call_booked' AND at >= $1 AND at < $2) AS calls,
       (SELECT COUNT(*) FROM events WHERE type = 'proposal_sent' AND at >= $1 AND at < $2) AS proposals,
       (SELECT COUNT(*) FROM events WHERE type = 'signed' AND at >= $1 AND at < $2) AS signed,
       (SELECT COUNT(*) FROM events WHERE type = 'paid' AND at >= $1 AND at < $2) AS paid,
       (SELECT COUNT(*) FROM events WHERE type = 'bounce' AND at >= $1 AND at < $2) AS bounces,
       (SELECT COUNT(*) FROM events WHERE type = 'unsubscribe' AND at >= $1 AND at < $2) AS unsubscribes,
       (SELECT COUNT(*) FROM events WHERE type = 'walk_in_visit' AND at >= $1 AND at < $2) AS walk_ins`,
    [weekStart, end],
  );
  return {
    weekStart, newLeads: row.new_leads, contacted: row.contacted, followups: row.followups, replies: row.replies,
    calls: row.calls, proposals: row.proposals, signed: row.signed, paid: row.paid, bounces: row.bounces,
    unsubscribes: row.unsubscribes, walkIns: row.walk_ins,
  };
}

function pct(n: number, d: number): string {
  return d ? `${((n / d) * 100).toFixed(1)}%` : "–";
}

export function reportRoutes(): Router {
  const r = Router();

  r.get("/replies", async (req, res) => {
    const rows = await query(
      `SELECT i.*, l.business_name, l.stage FROM inbound i LEFT JOIN leads l ON l.id = i.lead_id
       WHERE i.classification IN ('reply', 'unsubscribe') AND ($1 OR i.handled_at IS NULL)
       ORDER BY i.handled_at NULLS FIRST, i.received_at DESC LIMIT 200`,
      [req.query.all === "1"],
    );
    page(req, res, "Replies", "/replies", html`
      <h1>Replies</h1>
      <p class="sub">Answer these from the outreach mailbox. Each lead's follow-ups were stopped when the reply arrived.
        ${req.query.all === "1" ? html`<a href="/replies">Hide handled</a>` : html`<a href="/replies?all=1">Show handled</a>`}</p>
      ${rows.length === 0 ? html`<div class="card muted">No replies waiting.</div>` : ""}
      ${rows.map((m: any) => html`<div class="card">
        <div class="row" style="justify-content:space-between">
          <div><strong><a href="/leads/${m.lead_id}">${m.business_name ?? m.from_email}</a></strong>
            ${m.classification === "unsubscribe" ? html`<span class="chip bad">opted out</span>` : ""}
            <span class="small muted">${m.from_email} · ${formatLocal(m.received_at)}</span></div>
          ${m.handled_at ? html`<span class="chip good">handled</span>` : html`<form method="post" action="/replies/${m.id}/handled"><button>Mark handled</button></form>`}
        </div>
        <div class="small muted" style="margin:6px 0">${m.subject}</div>
        <pre class="mail">${m.snippet}</pre>
      </div>`)}`);
  });

  r.post("/replies/:id/handled", async (req, res) => {
    await query("UPDATE inbound SET handled_at = now() WHERE id = $1", [Number(req.params.id)]);
    res.redirect("/replies");
  });

  // The weekly scoreboard updates itself from the lead database.
  r.get("/scoreboard", async (req, res) => {
    const thisWeek = startOfLocalWeek(new Date());
    const weeks: WeekStats[] = [];
    for (let i = 0; i < 8; i++) weeks.push(await weekStats(addDays(thisWeek, -7 * i)));
    const w = weeks[0];
    const bySource = await query<{ source: string; leads: number; contacted: number; replied: number; signed: number }>(
      `SELECT s.source,
              COUNT(DISTINCT l.id) AS leads,
              COUNT(DISTINCT l.id) FILTER (WHERE l.stage IN ('contacted','replied','call','proposal','signed','paid')) AS contacted,
              COUNT(DISTINCT l.id) FILTER (WHERE EXISTS (SELECT 1 FROM events e WHERE e.lead_id = l.id AND e.type = 'reply')) AS replied,
              COUNT(DISTINCT l.id) FILTER (WHERE l.stage IN ('signed','paid')) AS signed
       FROM lead_sources s JOIN leads l ON l.id = s.lead_id GROUP BY s.source ORDER BY leads DESC`,
    );
    const rejections = await query<{ reason: string; n: number }>(
      `SELECT detail->>'reason' AS reason, COUNT(*) AS n FROM events WHERE type = 'rejected' AND at > now() - interval '30 days'
       GROUP BY 1 ORDER BY n DESC LIMIT 10`,
    );
    const pipeline = await query<{ stage: string; n: number }>(
      "SELECT stage, COUNT(*) AS n FROM leads WHERE archived_at IS NULL GROUP BY stage",
    );
    const sent14 = await query<{ sent: number; bounced: number }>(
      `SELECT (SELECT COUNT(*) FROM messages WHERE status = 'sent' AND sent_at > now() - interval '14 days') AS sent,
              (SELECT COUNT(*) FROM events WHERE type = 'bounce' AND at > now() - interval '14 days') AS bounced`,
    );
    const stat = (n: number | string, label: string) => html`<div class="stat"><div class="n">${n}</div><div class="l">${label}</div></div>`;
    page(req, res, "Scoreboard", "/scoreboard", html`
      <h1>Scoreboard</h1>
      <p class="sub">Week of ${formatLocal(w.weekStart).replace(/,.*/, "")}</p>
      <div class="stats">
        ${stat(w.newLeads, "new leads")}${stat(w.contacted, "first emails sent")}${stat(w.walkIns, "walk-in visits")}
        ${stat(w.replies, "replies")}${stat(w.calls, "calls booked")}${stat(w.proposals, "proposals")}
        ${stat(w.signed, "signings")}${stat(w.paid, "paid")}
      </div>
      <div class="stats">
        ${stat(pct(w.replies, w.contacted), "reply rate this week")}
        ${stat(pct(sent14[0].bounced, sent14[0].sent), "bounce rate, last 14 days (keep under 2%)")}
        ${stat(w.unsubscribes, "opt-outs this week")}
      </div>
      <h2>Last 8 weeks</h2>
      <div class="table-wrap"><table>
        <tr><th>Week of</th><th class="num">New leads</th><th class="num">Contacted</th><th class="num">Follow-ups</th><th class="num">Replies</th>
          <th class="num">Calls</th><th class="num">Proposals</th><th class="num">Signed</th><th class="num">Paid</th><th class="num">Bounces</th></tr>
        ${weeks.map((x) => html`<tr><td>${formatLocal(x.weekStart).replace(/,.*/, "")}</td><td class="num">${x.newLeads}</td>
          <td class="num">${x.contacted}</td><td class="num">${x.followups}</td><td class="num">${x.replies}</td><td class="num">${x.calls}</td>
          <td class="num">${x.proposals}</td><td class="num">${x.signed}</td><td class="num">${x.paid}</td><td class="num">${x.bounces}</td></tr>`)}
      </table></div>
      <h2>Which sources produce signings</h2>
      <div class="table-wrap"><table><tr><th>Source</th><th class="num">Leads</th><th class="num">Contacted</th><th class="num">Replied</th><th class="num">Signed</th></tr>
        ${bySource.map((s) => html`<tr><td>${s.source}</td><td class="num">${s.leads}</td><td class="num">${s.contacted}</td><td class="num">${s.replied}</td><td class="num">${s.signed}</td></tr>`)}
      </table></div>
      <h2>Pipeline</h2>
      <p class="row">${pipeline.map((p) => html`<a class="chip" href="/leads?stage=${p.stage}">${p.stage} ${p.n}</a>`)}</p>
      <h2>Rejection reasons, last 30 days</h2>
      ${rejections.length ? html`<ul>${rejections.map((x) => html`<li>${x.reason}: ${x.n}</li>`)}</ul>` : html`<p class="muted">None.</p>`}
    `);
  });

  return r;
}
