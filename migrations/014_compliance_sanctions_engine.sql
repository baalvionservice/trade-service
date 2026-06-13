-- 014 — Compliance & Sanctions Engine (War Room 4, Prompt 8).
--
-- Persists the compliance reference database (sanctioned parties, controlled
-- goods, country-specific trade bans) PLUS the tenant-scoped blacklist/whitelist
-- overrides and an append-only audit of compliance SCREENING runs.
--
-- NOTE on numbering: 009→013 are taken (tradeops foundation → HS codes). 014
-- keeps this migration unambiguous on a clean rebuild.
--
-- Five tables in schema `tradeops`:
--   • compliance_sanctioned_parties — GLOBAL reference (no tenant_id): sanctioned
--                                     countries / restricted parties / entities /
--                                     vessels. Shared registry like `carriers`.
--   • compliance_controlled_goods   — GLOBAL reference (no tenant_id): restricted,
--                                     dual-use and prohibited goods (HS-prefix +
--                                     keyword matched, with export-control regimes).
--   • compliance_trade_bans         — GLOBAL reference (no tenant_id): country-
--                                     specific export/import bans + embargoes
--                                     (the country-specific rule mapping).
--   • compliance_list_entries       — TENANT-SCOPED, RLS: per-tenant blacklist /
--                                     whitelist overrides (a tenant can deny a
--                                     counterparty or allow a normally-flagged good).
--   • compliance_screenings         — TENANT-SCOPED, RLS, append-only audit of
--                                     screening runs (decision / risk_score /
--                                     severity / violations / KYC+AML status).
--
-- The three reference tables are seeded FROM service/compliance/dataset.js (single
-- source of truth) by seedCompliance.js — this migration only builds the
-- structure. They carry no tenant_id, so the index.js tenant hooks skip them and
-- they are intentionally left WITHOUT RLS (read-only shared reference data,
-- consistent with the global `carriers` / `hs_codes` registries).
--
-- Design guarantees (mirror 008/009/010/011/012/013):
--   • Tenant isolation — RLS fail-closed on the two tenant-scoped tables.
--   • migrate.js NOTE — splits on ";\n", so NO DO-blocks / multi-statement
--     function bodies; every RLS policy is written explicitly per table.

-- ─────────────────────────────────────────────────────────────────────────────
-- SANCTIONED PARTIES (global reference)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tradeops.compliance_sanctioned_parties (
    id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    party_type    text          NOT NULL DEFAULT 'entity',
    name          text          NOT NULL,
    country       text,
    aliases       text[]        NOT NULL DEFAULT '{}',
    program       text,
    list_source   text          NOT NULL DEFAULT 'platform',
    severity      text          NOT NULL DEFAULT 'high',
    notes         text,
    metadata      jsonb         NOT NULL DEFAULT '{}'::jsonb,
    active        boolean       NOT NULL DEFAULT true,
    created_at    timestamptz   NOT NULL DEFAULT now(),
    updated_at    timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT chk_sanctioned_parties_type CHECK (party_type IN ('country','entity','individual','vessel','organization')),
    CONSTRAINT chk_sanctioned_parties_severity CHECK (severity IN ('low','medium','high','critical')),
    CONSTRAINT uq_sanctioned_parties UNIQUE (list_source, party_type, name, country)
);

CREATE INDEX IF NOT EXISTS idx_sanctioned_parties_country ON tradeops.compliance_sanctioned_parties (country);
CREATE INDEX IF NOT EXISTS idx_sanctioned_parties_type    ON tradeops.compliance_sanctioned_parties (party_type);
CREATE INDEX IF NOT EXISTS idx_sanctioned_parties_aliases ON tradeops.compliance_sanctioned_parties USING gin (aliases);

-- ─────────────────────────────────────────────────────────────────────────────
-- CONTROLLED GOODS (global reference) — restricted / dual-use / prohibited
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tradeops.compliance_controlled_goods (
    id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    code             text          NOT NULL UNIQUE,
    control_type     text          NOT NULL DEFAULT 'restricted',
    category         text          NOT NULL,
    description      text          NOT NULL,
    hs_prefixes      text[]        NOT NULL DEFAULT '{}',
    keywords         text[]        NOT NULL DEFAULT '{}',
    regimes          jsonb         NOT NULL DEFAULT '[]'::jsonb,
    severity         text          NOT NULL DEFAULT 'high',
    license_required boolean       NOT NULL DEFAULT true,
    active           boolean       NOT NULL DEFAULT true,
    created_at       timestamptz   NOT NULL DEFAULT now(),
    updated_at       timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT chk_controlled_goods_type CHECK (control_type IN ('restricted','dual_use','prohibited')),
    CONSTRAINT chk_controlled_goods_severity CHECK (severity IN ('low','medium','high','critical'))
);

CREATE INDEX IF NOT EXISTS idx_controlled_goods_type     ON tradeops.compliance_controlled_goods (control_type);
CREATE INDEX IF NOT EXISTS idx_controlled_goods_category ON tradeops.compliance_controlled_goods (category);
CREATE INDEX IF NOT EXISTS idx_controlled_goods_hs       ON tradeops.compliance_controlled_goods USING gin (hs_prefixes);
CREATE INDEX IF NOT EXISTS idx_controlled_goods_keywords ON tradeops.compliance_controlled_goods USING gin (keywords);

-- ─────────────────────────────────────────────────────────────────────────────
-- TRADE BANS (global reference) — country-specific export/import bans + embargoes
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tradeops.compliance_trade_bans (
    id                   uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    code                 text          NOT NULL UNIQUE,
    jurisdiction         text          NOT NULL DEFAULT 'GLOBAL',
    direction            text          NOT NULL DEFAULT 'both',
    counterparty_country text          NOT NULL DEFAULT '*',
    category             text          NOT NULL DEFAULT '*',
    hs_prefixes          text[]        NOT NULL DEFAULT '{}',
    description          text          NOT NULL,
    severity             text          NOT NULL DEFAULT 'critical',
    active               boolean       NOT NULL DEFAULT true,
    created_at           timestamptz   NOT NULL DEFAULT now(),
    updated_at           timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT chk_trade_bans_direction CHECK (direction IN ('export','import','both')),
    CONSTRAINT chk_trade_bans_severity CHECK (severity IN ('low','medium','high','critical'))
);

CREATE INDEX IF NOT EXISTS idx_trade_bans_jurisdiction ON tradeops.compliance_trade_bans (jurisdiction);
CREATE INDEX IF NOT EXISTS idx_trade_bans_counterparty ON tradeops.compliance_trade_bans (counterparty_country);

-- ─────────────────────────────────────────────────────────────────────────────
-- TENANT BLACKLIST / WHITELIST (tenant-scoped, RLS)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tradeops.compliance_list_entries (
    id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     text          NOT NULL DEFAULT 'T-DEMO',
    list_type     text          NOT NULL DEFAULT 'blacklist',
    subject_type  text          NOT NULL DEFAULT 'party',
    value         text          NOT NULL,
    reason        text,
    severity      text          NOT NULL DEFAULT 'high',
    active        boolean       NOT NULL DEFAULT true,
    expires_at    timestamptz,
    created_by    text,
    created_at    timestamptz   NOT NULL DEFAULT now(),
    updated_at    timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT chk_list_entries_list_type CHECK (list_type IN ('blacklist','whitelist')),
    CONSTRAINT chk_list_entries_subject_type CHECK (subject_type IN ('party','country','good','hs_code','entity')),
    CONSTRAINT chk_list_entries_severity CHECK (severity IN ('low','medium','high','critical')),
    CONSTRAINT uq_list_entries UNIQUE (tenant_id, list_type, subject_type, value)
);

CREATE INDEX IF NOT EXISTS idx_list_entries_tenant_lookup ON tradeops.compliance_list_entries (tenant_id, list_type, subject_type);
CREATE INDEX IF NOT EXISTS idx_list_entries_value         ON tradeops.compliance_list_entries (value);

ALTER TABLE tradeops.compliance_list_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE tradeops.compliance_list_entries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tradeops.compliance_list_entries;
CREATE POLICY tenant_isolation ON tradeops.compliance_list_entries
    USING ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)))
    WITH CHECK ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)));

-- ─────────────────────────────────────────────────────────────────────────────
-- COMPLIANCE SCREENINGS (tenant-scoped, append-only audit, RLS)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tradeops.compliance_screenings (
    id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           text          NOT NULL DEFAULT 'T-DEMO',
    subject_ref         text,
    trade_operation_id  uuid,
    shipment_id         uuid,
    decision            text          NOT NULL DEFAULT 'clear',
    risk_score          numeric(5,2)  NOT NULL DEFAULT 0,
    severity            text          NOT NULL DEFAULT 'none',
    violation_count     integer       NOT NULL DEFAULT 0,
    blocking            boolean       NOT NULL DEFAULT false,
    origin_country      text,
    destination_country text,
    parties             jsonb         NOT NULL DEFAULT '[]'::jsonb,
    goods               jsonb         NOT NULL DEFAULT '[]'::jsonb,
    violations          jsonb         NOT NULL DEFAULT '[]'::jsonb,
    checks              jsonb         NOT NULL DEFAULT '{}'::jsonb,
    kyc_status          text          NOT NULL DEFAULT 'not_checked',
    aml_status          text          NOT NULL DEFAULT 'not_checked',
    report              jsonb         NOT NULL DEFAULT '{}'::jsonb,
    engine_version      text,
    trigger             text          NOT NULL DEFAULT 'manual',
    reason              text,
    created_by          text,
    created_at          timestamptz   NOT NULL DEFAULT now(),
    updated_at          timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT fk_compliance_screenings_trade_operation FOREIGN KEY (trade_operation_id) REFERENCES tradeops.trade_operations (id) ON DELETE SET NULL,
    CONSTRAINT chk_compliance_screenings_decision CHECK (decision IN ('clear','review','block')),
    CONSTRAINT chk_compliance_screenings_severity CHECK (severity IN ('none','low','medium','high','critical')),
    CONSTRAINT chk_compliance_screenings_kyc CHECK (kyc_status IN ('not_checked','pending','passed','failed','review')),
    CONSTRAINT chk_compliance_screenings_aml CHECK (aml_status IN ('not_checked','pending','passed','failed','review')),
    CONSTRAINT chk_compliance_screenings_trigger CHECK (trigger IN ('manual','api','workflow_transition','order','placement','scheduler','backfill')),
    CONSTRAINT chk_compliance_screenings_risk CHECK (risk_score >= 0 AND risk_score <= 100)
);

CREATE INDEX IF NOT EXISTS idx_compliance_screenings_tenant_decision ON tradeops.compliance_screenings (tenant_id, decision);
CREATE INDEX IF NOT EXISTS idx_compliance_screenings_operation       ON tradeops.compliance_screenings (trade_operation_id) WHERE trade_operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_compliance_screenings_shipment        ON tradeops.compliance_screenings (shipment_id) WHERE shipment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_compliance_screenings_created_brin    ON tradeops.compliance_screenings USING brin (created_at);

ALTER TABLE tradeops.compliance_screenings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tradeops.compliance_screenings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tradeops.compliance_screenings;
CREATE POLICY tenant_isolation ON tradeops.compliance_screenings
    USING ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)))
    WITH CHECK ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)));
