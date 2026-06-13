-- 015 — Customs Gateway Abstraction Layer (War Room 4, Prompt 9).
--
-- Persists connector-driven customs filings to the four government gateways
-- (ICEGATE / ACE / EU CDS / Mirsal 2) PLUS an append-only audit of every
-- transmission attempt + lifecycle transition.
--
-- NOTE on numbering: 009→014 are taken (tradeops foundation → compliance). 015
-- keeps this migration unambiguous on a clean rebuild.
--
-- Two tables in schema `tradeops`:
--   • customs_submissions       — TENANT-SCOPED, RLS: the tracked filing. status
--                                 walks queued → submitting → submitted/accepted/
--                                 rejected/failed/cancelled. gateway_* + the
--                                 normalized_response are the normalized projection
--                                 of whichever gateway answered.
--   • customs_submission_events — TENANT-SCOPED, RLS, append-only audit: one
--                                 immutable row per attempt/transition (the durable
--                                 trail behind a filing's outcome).
--
-- Design guarantees (mirror 008/009/010/011/012/013/014):
--   • Tenant isolation — RLS fail-closed on both tenant-scoped tables.
--   • migrate.js NOTE — splits on ";\n", so NO DO-blocks / multi-statement
--     function bodies; every RLS policy is written explicitly per table.

-- ─────────────────────────────────────────────────────────────────────────────
-- CUSTOMS SUBMISSIONS (tenant-scoped, RLS) — the tracked filing lifecycle
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tradeops.customs_submissions (
    id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           text          NOT NULL DEFAULT 'T-DEMO',
    customs_entry_id    text,
    shipment_id         uuid,
    trade_operation_id  uuid,
    channel             text          NOT NULL,
    direction           text          NOT NULL DEFAULT 'import',
    origin_country      text,
    destination_country text,
    status              text          NOT NULL DEFAULT 'queued',
    attempts            integer       NOT NULL DEFAULT 0,
    max_attempts        integer       NOT NULL DEFAULT 3,
    gateway_reference   text,
    gateway_status      text,
    declaration         jsonb         NOT NULL DEFAULT '{}'::jsonb,
    normalized_response jsonb,
    messages            jsonb         NOT NULL DEFAULT '[]'::jsonb,
    last_error          text,
    failure_kind        text,
    idempotency_key     text,
    engine_version      text,
    submitted_at        timestamptz,
    completed_at        timestamptz,
    created_by          text,
    created_at          timestamptz   NOT NULL DEFAULT now(),
    updated_at          timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT fk_customs_submissions_trade_operation FOREIGN KEY (trade_operation_id) REFERENCES tradeops.trade_operations (id) ON DELETE SET NULL,
    CONSTRAINT chk_customs_submissions_channel CHECK (channel IN ('icegate','ace','eu_cds','mirsal')),
    CONSTRAINT chk_customs_submissions_direction CHECK (direction IN ('import','export')),
    CONSTRAINT chk_customs_submissions_status CHECK (status IN ('draft','queued','submitting','submitted','accepted','rejected','failed','cancelled')),
    CONSTRAINT chk_customs_submissions_failure_kind CHECK (failure_kind IS NULL OR failure_kind IN ('validation','transient','permanent')),
    CONSTRAINT uq_customs_submissions_idem UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_customs_submissions_tenant_status ON tradeops.customs_submissions (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_customs_submissions_channel       ON tradeops.customs_submissions (channel);
CREATE INDEX IF NOT EXISTS idx_customs_submissions_shipment      ON tradeops.customs_submissions (shipment_id) WHERE shipment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customs_submissions_operation     ON tradeops.customs_submissions (trade_operation_id) WHERE trade_operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customs_submissions_inflight      ON tradeops.customs_submissions (status, updated_at) WHERE status IN ('queued','submitting','submitted');
CREATE INDEX IF NOT EXISTS idx_customs_submissions_created_brin  ON tradeops.customs_submissions USING brin (created_at);

ALTER TABLE tradeops.customs_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tradeops.customs_submissions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tradeops.customs_submissions;
CREATE POLICY tenant_isolation ON tradeops.customs_submissions
    USING ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)))
    WITH CHECK ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)));

-- ─────────────────────────────────────────────────────────────────────────────
-- CUSTOMS SUBMISSION EVENTS (tenant-scoped, append-only audit, RLS)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tradeops.customs_submission_events (
    id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     text          NOT NULL DEFAULT 'T-DEMO',
    submission_id uuid          NOT NULL,
    channel       text,
    event_type    text          NOT NULL,
    status        text,
    attempt       integer,
    message       text,
    detail        jsonb         NOT NULL DEFAULT '{}'::jsonb,
    created_by    text,
    created_at    timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT fk_customs_submission_events_submission FOREIGN KEY (submission_id) REFERENCES tradeops.customs_submissions (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_customs_submission_events_submission ON tradeops.customs_submission_events (submission_id, created_at);
CREATE INDEX IF NOT EXISTS idx_customs_submission_events_tenant     ON tradeops.customs_submission_events (tenant_id);

ALTER TABLE tradeops.customs_submission_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE tradeops.customs_submission_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tradeops.customs_submission_events;
CREATE POLICY tenant_isolation ON tradeops.customs_submission_events
    USING ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)))
    WITH CHECK ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)));
