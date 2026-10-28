# Leadz: lead generator and email scheduler

An internal tool for PureTech's outreach. It finds local businesses, checks their website and Google presence, scores them, drafts a personal first email with Claude, and sends approved emails and follow-ups on a schedule. A person approves every first email before it goes out.

It follows the design doc *Lead Generator and Email Scheduler* (Oct 28, 2026).

```
Lead sources ─▶ Ingest + dedupe ─▶ Enrich + score ─▶ Claude first draft
 (Places, NY filings,                                       │
  web form, referrals,                                      ▼
  manual)                                            Human review (web app)
                                                            │
Reply watcher ◀─ Gmail API send ◀─ Send scheduler ◀─────────┘
        └──────────────▶ Postgres: leads, checks, drafts, messages, events ◀── scoreboard
```

## What's here

| Component | Code | Runs |
|---|---|---|
| Source jobs | `src/sources/places.ts`, `src/sources/nyFilings.ts`, form webhook in `src/web/routes/public.ts`, manual/referral form in `src/web/routes/leads.ts` | Weekly (Mon 5 a.m.), instantly for form submissions |
| Ingest | `src/pipeline/ingest.ts` | After each source job |
| Enricher | `src/enrich/` (site fetch, HTTPS, PageSpeed mobile score, viewport, copyright year, booking, published email) | After ingest |
| Scorer | `src/score/scorer.ts` | After enrichment |
| Drafter | `src/draft/` (facts, templates, Claude call, validator) | Leads scoring 60+, or on request |
| Review UI | `src/web/` | On demand |
| Scheduler | `src/send/scheduler.ts` | Every 10 minutes |
| Watcher | `src/watch/` | Every 10 minutes |
| Maintenance | `src/jobs/maintenance.ts` | Daily (retention and Places data cleanup) |

`npm start` runs the web app, and `npm run worker` runs the scheduled jobs. On a single-service host, set `RUN_JOBS=1` to run the jobs inside the web process instead. Both apply database migrations on start.

## The outreach lead's week

- **Review queue** (`/queue`): drafts sorted by score, with form requests first. The facts each draft may use appear beside it. Actions are approve, edit then approve, reject with a reason, redraft, or move to the walk-in list. Leads scoring 40 to 59 are listed below the drafts with a "Request draft" button.
- **Replies** (`/replies`): replies and opt-outs the watcher matched to a lead. The lead's follow-ups are already stopped by the time a reply shows up here.
- **Walk-in route** (`/walk-in`): high-scoring leads with no published email, grouped by street and printable. Leads that come only from NY filings never appear here.
- **Tracker** (`/leads`): every lead by stage, with search and a CSV export that feeds the existing tracker. Each lead page has outcome buttons: call booked, proposal sent, signed, paid, not interested, and do not contact.
- **Scoreboard** (`/scoreboard`): this week and the last 8 weeks of new leads, emails, replies, calls, proposals, and signings, plus which sources produce signings and the rejection reasons.
- **Admin** (`/admin`, J only): target ZIPs and categories, scoring weights and thresholds, chain names, the founding-client offer switch, the sending window and holidays, ramp and cap, the mailing address, templates, the suppression list, deliverability numbers, alerts, and buttons to run any job now.

## How the main rules are enforced

**Scoring** uses the design weights, all editable in Admin: no website +35, broken or not HTTPS +15, mobile score below 50 +15, copyright year 3 or more years old +10, appointment business with no online booking +10, fewer than 20 reviews +10, rating below 4.0 +5, published email +10, chain or franchise -40. Scores are capped to 0–100. Leads scoring 60 or more are drafted. Leads scoring 40 to 59 are queued without a draft. Leads below 40 are archived and re-checked in 90 days. A lead with no email but a score of 50 or more goes on the walk-in route. Form submissions skip the thresholds and go to the top of the queue.

**Emails are never guessed.** The tool only uses addresses from `mailto:` links or text on the business's own site (or its contact page), or addresses the business submitted itself.

**Drafts use facts only.** `facts_json` holds exactly the measured results. Claude (`claude-haiku-5-5` by default, the fast low-cost model the doc calls for; set `CLAUDE_MODEL` to change it) writes a subject and a body under 120 words, with one problem, one offer, and one question. The system appends the signature and the CAN-SPAM footer. The validator rejects a draft when:

- a number doesn't appear in the facts
- it makes a claim the facts don't back (mobile speed, no website, HTTPS, broken site, booking, reviews, rating, copyright, mobile layout, or the founding offer)
- the subject mentions something the body doesn't, or starts with a fake `Re:` or `Fwd:`
- a banned phrase appears
- it is too long or has no question
- the footer, postal address, unsubscribe link, or "reply stop" line is missing

A failing draft is regenerated once with the errors, then flagged for manual writing. A human edit is re-checked, and only compliance failures (footer, address, banned phrases, fake `Re:`) block approval.

**Sequence:**

- Day 0: the approved email.
- Day 4: a bump in the same thread.
- Day 10: an offer of the free check-up in the same thread.
- Day 11: the sequence ends, and the lead moves to a call (or a walk-in visit if there's no phone).

Follow-ups are pre-approved templates and are scheduled from when step 1 actually went out.

**Sending rules:**

- Mail goes out weekdays 9:30 a.m. to 4:30 p.m. Eastern. Thanksgiving week, Dec 22–31, and any extra dates you add are skipped.
- The daily cap is 15 in the first week, 25 in the second, then 40. It counts from the first send, or from a ramp start date you set. A manual override is available.
- Sends are spaced 3 to 8 minutes apart at random.
- Before every send, the scheduler re-checks the suppression list and the lead's current stage.
- Each message carries its own `Message-ID`. A run that died mid-send is reconciled against Gmail before any retry, so nothing is sent twice.
- Failed sends retry after 5 and 15 minutes. After the third failure, the tool raises an alert and emails J.

**The watcher** reads the Gmail history every 10 minutes and matches messages to leads by thread ID. Bounces are also matched by the failed address.

- **Reply:** stops the sequence, sets the stage to replied, and notifies the outreach lead.
- **Out-of-office:** pushes the next step back to the stated return date, or by 7 days.
- **Bounce:** stops the sequence, sets the stage to bounced, and suppresses the address.
- **"Stop", "unsubscribe", or "remove me":** stops the sequence and suppresses the address immediately.

**Opt-out links** are signed tokens with no expiry. Every message also has a `List-Unsubscribe` header with one-click POST support (RFC 8058). Suppression entries can't be deleted: the table ignores `DELETE`.

**Data handling:**

- Archived leads with no engagement are deleted after 12 months.
- Places rating and review counts are cleared after 30 days and refreshed from the place ID when a lead is worked.
- Access requires a login, and each user has their own account.

## Setup

Requirements: Node 22.9+ and Postgres 14+.

```bash
npm install
cp .env.example .env          # fill in keys; keep DRY_RUN=1 until sending is verified
npm run migrate
npm run cli -- create-user j@puretech.example J admin 'a-strong-password'
npm run cli -- create-user outreach@puretech.example 'Outreach Lead' outreach 'another-password'
npm run build
npm start                     # web app on PORT
npm run worker                # scheduled jobs
```

Then sign in as J, open **Admin**, and set the **mailing address**. Drafts can't pass validation without it.

### Deploying on Railway

`railway.json` tells Railway to build with Railpack (`npm run build`), start the web app with `npm start`, and health-check `/healthz`. Node 22 is pinned by `.node-version`.

1. Add a **Postgres** database to the project. On the app service, set `DATABASE_URL` to `${{Postgres.DATABASE_URL}}`.
2. Set the other variables from `.env.example`, at least `APP_BASE_URL` (the service's public https URL), `SESSION_SECRET`, `UNSUBSCRIBE_SECRET`, and `NODE_ENV=production`.
3. Set `RUN_JOBS=1` so the scheduled jobs run inside the web service. Without it, nothing is sent and no leads are pulled.
4. After the first deploy, create the users from the service shell: `npm run cli -- create-user ...`.

### Keys and accounts

- **Google Places API (New)** and **PageSpeed Insights API**: one Google Cloud API key with both APIs enabled. Text Search requests only the fields scoring uses.
- **NY open data**: an optional app token for data.ny.gov. The filings source reads the "Active Corporations" dataset (`n9v6-gdp6`). Check the field names in `src/sources/nyFilings.ts` against the live dataset before relying on it.
- **Claude API**: `ANTHROPIC_API_KEY`. Without it, leads are still checked and scored, but nothing is drafted automatically.
- **Gmail API**: create an OAuth client in the Workspace's Google Cloud project. Get a refresh token for the outreach mailbox with the `gmail.send` and `gmail.readonly` scopes. Set `SENDER_EMAIL` to that mailbox and `SENDER_NAME` to the real person sending.
- **Check-up form**: have the website form POST JSON to `/hooks/form` with the header `X-Webhook-Secret: $FORM_WEBHOOK_SECRET`. Required fields are `business_name` and `email`. Optional fields are `phone`, `website`, `address`, `category`, `message`, `consent`, and `submission_id`.

### Before going live

1. Set up SPF, DKIM, and DMARC on the outreach subdomain (for example `outreach.puretech.com`), aligned with the From domain.
2. Have the footer and opt-out flow reviewed. This tool implements the design's compliance summary; that summary isn't legal advice.
3. Check Google Maps Platform's current terms on storing Places content.
4. Run with `DRY_RUN=1`, then send test emails to J's own addresses. Confirm that a reply stops the sequence and that an opt-out reaches suppression within minutes.
5. Watch the spam rate in Google Postmaster Tools. During the pilot, keep the cap at 15 (Admin → daily cap override) until two weeks pass with bounces under 2% and no complaints.

## Commands

```
npm run cli -- migrate | weekly | process | draft <leadId> | scheduler | watcher | maintenance
npm test        # needs a Postgres database; set TEST_DATABASE_URL (default postgres://leadz:leadz@localhost:5432/leadz_test)
npm run typecheck
```

## Open questions from the design doc

- **Mailing address for the footer**: an office, a registered PO box, or a private mailbox? It is set in Admin, and nothing can be approved until it is set.
- **Reply notifications**: they always show in the in-app Replies view. They are also emailed to `REPLY_NOTIFY_EMAIL` when that's set. Text notifications aren't built.
