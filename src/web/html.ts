// Tiny HTML templating: tagged template literals with automatic escaping.

export class SafeHtml {
  constructor(readonly value: string) {}
  toString() {
    return this.value;
  }
}

export function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function render(v: unknown): string {
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(render).join("");
  if (v === null || v === undefined || v === false) return "";
  return escapeHtml(v);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

export function raw(s: string): SafeHtml {
  return new SafeHtml(s);
}

const STYLES = `
:root { --bg:#f7f6f3; --card:#fff; --ink:#1d1d1b; --muted:#6b6a65; --line:#e3e1db; --accent:#1f5fbf; --accent-ink:#fff;
  --good:#1e7a46; --warn:#a15c00; --bad:#b3261e; --chip:#efede7; }
@media (prefers-color-scheme: dark) { :root { --bg:#161615; --card:#1f1f1d; --ink:#ecebe7; --muted:#a3a19a; --line:#34332f;
  --accent:#6ea0ff; --accent-ink:#0b1730; --good:#5cc68a; --warn:#e3a54a; --bad:#ff8a80; --chip:#2a2a27; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
a { color:var(--accent); }
header.top { display:flex; gap:16px; align-items:center; flex-wrap:wrap; padding:10px 20px; border-bottom:1px solid var(--line); background:var(--card); }
header.top .brand { font-weight:700; margin-right:8px; }
header.top nav { display:flex; gap:14px; flex-wrap:wrap; }
header.top nav a { text-decoration:none; color:var(--muted); }
header.top nav a.on { color:var(--ink); font-weight:600; }
header.top .who { margin-left:auto; color:var(--muted); font-size:13px; display:flex; gap:10px; align-items:center; }
main { max-width:1180px; margin:0 auto; padding:20px 16px 60px; }
h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:17px; margin:24px 0 8px; }
.sub { color:var(--muted); margin:0 0 16px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:14px; }
.grid { display:grid; grid-template-columns: minmax(0,1fr) 300px; gap:16px; }
@media (max-width: 820px) { .grid { grid-template-columns: 1fr; } }
.row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.chip { display:inline-block; background:var(--chip); border-radius:999px; padding:1px 9px; font-size:12.5px; color:var(--ink); }
.chip.good { color:var(--good); } .chip.warn { color:var(--warn); } .chip.bad { color:var(--bad); }
.score { font-weight:700; font-size:20px; font-variant-numeric: tabular-nums; }
.muted { color:var(--muted); } .small { font-size:13px; }
.err { color:var(--bad); } .ok { color:var(--good); }
ul.facts { margin:6px 0 0; padding-left:18px; } ul.facts li { margin:2px 0; }
input[type=text], input[type=email], input[type=password], input[type=number], input[type=date], input[type=url], select, textarea {
  width:100%; padding:7px 9px; border:1px solid var(--line); border-radius:7px; background:var(--bg); color:var(--ink); font:inherit; }
textarea { min-height:300px; font-family: ui-monospace, Menlo, monospace; font-size:13.5px; }
textarea.short { min-height:80px; }
label { display:block; font-size:13px; color:var(--muted); margin:10px 0 3px; }
button, .btn { display:inline-block; border:1px solid var(--line); background:var(--card); color:var(--ink); padding:7px 13px; border-radius:7px;
  font:inherit; cursor:pointer; text-decoration:none; }
button.primary, .btn.primary { background:var(--accent); border-color:var(--accent); color:var(--accent-ink); font-weight:600; }
button.danger { color:var(--bad); }
table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
th { font-size:12.5px; color:var(--muted); font-weight:600; background:var(--chip); }
td.num, th.num { text-align:right; font-variant-numeric: tabular-nums; }
.table-wrap { overflow-x:auto; }
.stats { display:grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap:10px; margin-bottom:14px; }
.stat { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px; }
.stat .n { font-size:26px; font-weight:700; font-variant-numeric: tabular-nums; }
.stat .l { color:var(--muted); font-size:13px; }
.flash { padding:10px 14px; border-radius:8px; margin-bottom:14px; background:var(--chip); }
.flash.error { color:var(--bad); }
details summary { cursor:pointer; color:var(--muted); }
pre.mail { white-space:pre-wrap; font: 13.5px/1.5 ui-monospace, Menlo, monospace; background:var(--bg); padding:10px; border-radius:7px; border:1px solid var(--line); margin:0; }
@media print { header.top, .noprint { display:none !important; } body { background:#fff; color:#000; } .card { border-color:#999; break-inside: avoid; } }
`;

export interface LayoutUser {
  name: string;
  role: string;
}

export function layout(opts: { title: string; user?: LayoutUser | null; active?: string; flash?: { kind: string; text: string } | null; body: SafeHtml }): string {
  const nav: [string, string, boolean][] = [
    ["/queue", "Review queue", true],
    ["/replies", "Replies", true],
    ["/walk-in", "Walk-in route", true],
    ["/leads", "Tracker", true],
    ["/scoreboard", "Scoreboard", true],
    ["/admin", "Admin", opts.user?.role === "admin"],
  ];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)} · Leadz</title><style>${STYLES}</style></head><body>
${opts.user ? html`<header class="top"><span class="brand">Leadz</span><nav>${nav
    .filter(([, , show]) => show)
    .map(([href, label]) => html`<a href="${href}" class="${opts.active === href ? "on" : ""}">${label}</a>`)}</nav>
  <span class="who">${opts.user.name}<form method="post" action="/logout" style="display:inline"><button class="small">Sign out</button></form></span></header>` : ""}
<main>${opts.flash ? html`<div class="flash ${opts.flash.kind}">${opts.flash.text}</div>` : ""}${opts.body}</main></body></html>`;
}

export function stageChip(stage: string): SafeHtml {
  const tone = ["replied", "call", "proposal", "signed", "paid"].includes(stage)
    ? "good"
    : ["lost", "unsubscribed", "bounced"].includes(stage) ? "bad" : "";
  return html`<span class="chip ${tone}">${stage}</span>`;
}
