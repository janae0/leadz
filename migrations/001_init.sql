-- Lead generator and email scheduler: initial schema.
-- The leads table is the tracker; every other table hangs off it.

CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'outreach')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE leads (
  id               SERIAL PRIMARY KEY,
  business_name    TEXT NOT NULL,
  norm_name        TEXT NOT NULL,
  category         TEXT,
  address          TEXT,
  norm_address     TEXT,
  zip              TEXT,
  phone            TEXT,
  website          TEXT,
  website_domain   TEXT,
  email            TEXT,
  place_id         TEXT UNIQUE,
  -- Latest Places snapshot (rating, review count). Refreshed when the lead is
  -- worked and cleared by the retention job; the place ID is the durable key.
  places_json      JSONB,
  places_fetched_at TIMESTAMPTZ,
  stage            TEXT NOT NULL DEFAULT 'new' CHECK (stage IN (
                     'new', 'qualified', 'drafted', 'approved', 'contacted', 'replied',
                     'call', 'proposal', 'signed', 'paid',
                     'lost', 'unsubscribed', 'bounced')),
  score            INTEGER,
  score_breakdown  JSONB,
  fit              TEXT,
  is_chain         BOOLEAN NOT NULL DEFAULT false,
  priority         BOOLEAN NOT NULL DEFAULT false,
  walk_in          BOOLEAN NOT NULL DEFAULT false,
  walk_in_allowed  BOOLEAN NOT NULL DEFAULT true,
  walk_in_visited_at TIMESTAMPTZ,
  archived_at      TIMESTAMPTZ,
  owner            TEXT,
  notes            TEXT,
  next_action      TEXT,
  next_action_at   TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX leads_norm_name_address ON leads (norm_name, norm_address);
CREATE INDEX leads_website_domain ON leads (website_domain);
CREATE INDEX leads_stage ON leads (stage);
CREATE INDEX leads_email ON leads (lower(email));

CREATE TABLE lead_sources (
  id            SERIAL PRIMARY KEY,
  lead_id       INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  source        TEXT NOT NULL CHECK (source IN ('places', 'ny_filings', 'form', 'referral', 'manual')),
  source_ref    TEXT,
  referrer      TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (lead_id, source, source_ref)
);

CREATE TABLE checks (
  id             SERIAL PRIMARY KEY,
  lead_id        INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  ran_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  has_site       BOOLEAN,
  https_ok       BOOLEAN,
  http_status    INTEGER,
  final_url      TEXT,
  mobile_score   INTEGER,
  has_viewport   BOOLEAN,
  copyright_year INTEGER,
  has_booking    BOOLEAN,
  has_contact_form BOOLEAN,
  published_email TEXT,
  rating         NUMERIC(2,1),
  review_count   INTEGER,
  raw_json       JSONB
);
CREATE INDEX checks_lead_ran ON checks (lead_id, ran_at DESC);

CREATE TABLE templates (
  name         TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('first', 'followup')),
  description  TEXT NOT NULL,
  subject      TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL DEFAULT '',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE drafts (
  id                SERIAL PRIMARY KEY,
  lead_id           INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  template          TEXT NOT NULL,
  subject           TEXT NOT NULL,
  body              TEXT NOT NULL,
  facts_json        JSONB NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'edited')),
  needs_manual      BOOLEAN NOT NULL DEFAULT false,
  validation_errors JSONB,
  reject_reason     TEXT,
  reviewed_by       TEXT,
  reviewed_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX drafts_lead ON drafts (lead_id);
CREATE INDEX drafts_status ON drafts (status);

CREATE TABLE sequences (
  id    SERIAL PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE,
  steps JSONB NOT NULL  -- [{ "day": 0, "template": "first" }, { "day": 4, "template": "bump" }, ...]
);

CREATE TABLE enrollments (
  id          SERIAL PRIMARY KEY,
  lead_id     INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  sequence_id INTEGER NOT NULL REFERENCES sequences(id),
  draft_id    INTEGER REFERENCES drafts(id),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped', 'finished')),
  stop_reason TEXT,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at    TIMESTAMPTZ
);
-- One active enrollment per lead at most.
CREATE UNIQUE INDEX enrollments_one_active ON enrollments (lead_id) WHERE status = 'active';

CREATE TABLE messages (
  id               SERIAL PRIMARY KEY,
  enrollment_id    INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  step             INTEGER NOT NULL,
  to_email         TEXT NOT NULL,
  subject          TEXT NOT NULL,
  body             TEXT NOT NULL,
  scheduled_at     TIMESTAMPTZ NOT NULL,
  sent_at          TIMESTAMPTZ,
  idempotency_key  TEXT NOT NULL UNIQUE,
  rfc_message_id   TEXT,
  gmail_message_id TEXT,
  gmail_thread_id  TEXT,
  status           TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'sending', 'sent', 'failed', 'cancelled')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  UNIQUE (enrollment_id, step)
);
CREATE INDEX messages_due ON messages (status, scheduled_at);
CREATE INDEX messages_thread ON messages (gmail_thread_id);

CREATE TABLE events (
  id      SERIAL PRIMARY KEY,
  lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  type    TEXT NOT NULL CHECK (type IN (
            'reply', 'auto_reply', 'bounce', 'unsubscribe', 'call_booked', 'proposal_sent', 'signed', 'paid',
            'not_interested', 'do_not_contact', 'sent', 'approved', 'rejected', 'walk_in_visit')),
  at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  detail  JSONB
);
CREATE INDEX events_type_at ON events (type, at);
CREATE INDEX events_lead ON events (lead_id);

-- Checked before every send; entries are never deleted.
CREATE TABLE suppression (
  id       SERIAL PRIMARY KEY,
  value    TEXT NOT NULL UNIQUE,      -- lower-cased email address or bare domain
  kind     TEXT NOT NULL CHECK (kind IN ('email', 'domain')),
  reason   TEXT NOT NULL CHECK (reason IN ('unsubscribe', 'bounce', 'complaint', 'client', 'do_not_contact')),
  added_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE RULE suppression_no_delete AS ON DELETE TO suppression DO INSTEAD NOTHING;

-- Inbound messages the watcher matched to a lead, for the replies view.
CREATE TABLE inbound (
  id               SERIAL PRIMARY KEY,
  lead_id          INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  gmail_message_id TEXT NOT NULL UNIQUE,
  gmail_thread_id  TEXT,
  from_email       TEXT,
  subject          TEXT,
  snippet          TEXT,
  classification   TEXT NOT NULL,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  handled_at       TIMESTAMPTZ
);

CREATE TABLE alerts (
  id         SERIAL PRIMARY KEY,
  kind       TEXT NOT NULL,
  message    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

-- Small key/value store for settings J tunes in the UI, and for job state.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE job_runs (
  id          SERIAL PRIMARY KEY,
  job         TEXT NOT NULL,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  ok          BOOLEAN,
  summary     JSONB
);
