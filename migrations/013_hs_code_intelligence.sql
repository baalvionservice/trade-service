-- 013 — HS Code Intelligence Engine (Prompt 7).
--
-- Persists the HS code reference database (multi-country tariff mapping) plus an
-- append-only audit of product → HS classification runs.
--
-- NOTE on numbering: this is 013. The 011 prefix is shared by 011_document_engine
-- and 011_document_validation_engine (Prompts 4 & 5); 012 is taken by
-- 012_shipment_readiness_engine (Prompt 6). 013 keeps this migration unambiguous
-- on a clean rebuild.
--
-- Three tables in schema `tradeops`:
--   • hs_codes          — GLOBAL reference (no tenant_id): the 6-digit HS
--                         subheading catalogue. Shared registry like `carriers`.
--   • hs_tariff_lines   — GLOBAL reference (no tenant_id): per-country national
--                         line + duty/VAT rates + restrictions for an hs_code.
--   • hs_classifications — TENANT-SCOPED, append-only audit of suggestion runs
--                          (RLS fail-closed, mirrors 009/010/011).
--
-- The two reference tables are seeded FROM service/hscode/hsDatabase.js by
-- seedHsCodes.js (single source of truth) — this migration only builds the
-- structure. They carry no tenant_id, so the index.js tenant hooks skip them and
-- they are intentionally left WITHOUT RLS (read-only shared reference data,
-- consistent with the global `carriers` registry).
--
-- migrate.js NOTE — splits on ";\n", so NO DO-blocks / multi-statement function
-- bodies; every RLS policy is written explicitly per table.

-- ─────────────────────────────────────────────────────────────────────────────
-- HS CODE CATALOGUE (global reference)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tradeops.hs_codes (
    id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    hs_code       text          NOT NULL UNIQUE,
    heading       text          NOT NULL,
    chapter       text          NOT NULL,
    description   text          NOT NULL,
    category      text,
    unit          text,
    keywords      text[]        NOT NULL DEFAULT '{}',
    controls      jsonb         NOT NULL DEFAULT '[]'::jsonb,
    active        boolean       NOT NULL DEFAULT true,
    created_at    timestamptz   NOT NULL DEFAULT now(),
    updated_at    timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT chk_hs_codes_code_digits CHECK (hs_code ~ '^[0-9]{6,10}$')
);

CREATE INDEX IF NOT EXISTS idx_hs_codes_chapter   ON tradeops.hs_codes (chapter);
CREATE INDEX IF NOT EXISTS idx_hs_codes_heading   ON tradeops.hs_codes (heading);
CREATE INDEX IF NOT EXISTS idx_hs_codes_category  ON tradeops.hs_codes (category);
CREATE INDEX IF NOT EXISTS idx_hs_codes_keywords  ON tradeops.hs_codes USING gin (keywords);

-- ─────────────────────────────────────────────────────────────────────────────
-- MULTI-COUNTRY TARIFF LINES (global reference)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tradeops.hs_tariff_lines (
    id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    hs_code       text          NOT NULL,
    country       text          NOT NULL,
    national_code text,
    duty_rate     numeric(7,3)  NOT NULL DEFAULT 0,
    vat_rate      numeric(7,3)  NOT NULL DEFAULT 0,
    restrictions  jsonb         NOT NULL DEFAULT '{}'::jsonb,
    effective_from date,
    created_at    timestamptz   NOT NULL DEFAULT now(),
    updated_at    timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT fk_hs_tariff_lines_code FOREIGN KEY (hs_code) REFERENCES tradeops.hs_codes (hs_code) ON DELETE CASCADE,
    CONSTRAINT uq_hs_tariff_lines_code_country UNIQUE (hs_code, country)
);

CREATE INDEX IF NOT EXISTS idx_hs_tariff_lines_country  ON tradeops.hs_tariff_lines (country);
CREATE INDEX IF NOT EXISTS idx_hs_tariff_lines_national ON tradeops.hs_tariff_lines (national_code);

-- ─────────────────────────────────────────────────────────────────────────────
-- CLASSIFICATION AUDIT (tenant-scoped, append-only)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tradeops.hs_classifications (
    id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           text          NOT NULL DEFAULT 'T-DEMO',
    document_ref        text,
    product_description text,
    trade_operation_id  uuid,
    destination_country text,
    origin_country      text,
    suggested_code      text,
    national_code       text,
    method              text,
    confidence          integer       NOT NULL DEFAULT 0,
    confidence_band     text,
    needs_review        boolean       NOT NULL DEFAULT false,
    blocking            boolean       NOT NULL DEFAULT false,
    flag_count          integer       NOT NULL DEFAULT 0,
    duty_estimate       jsonb         NOT NULL DEFAULT '{}'::jsonb,
    report              jsonb         NOT NULL DEFAULT '{}'::jsonb,
    created_by          text,
    created_at          timestamptz   NOT NULL DEFAULT now(),
    updated_at          timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT fk_hs_classifications_trade_operation FOREIGN KEY (trade_operation_id) REFERENCES tradeops.trade_operations (id) ON DELETE SET NULL,
    CONSTRAINT chk_hs_classifications_method CHECK (method IS NULL OR method IN ('exact','search','ai','fallback','manual')),
    CONSTRAINT chk_hs_classifications_confidence CHECK (confidence >= 0 AND confidence <= 100)
);

CREATE INDEX IF NOT EXISTS idx_hs_classifications_tenant_code   ON tradeops.hs_classifications (tenant_id, suggested_code);
CREATE INDEX IF NOT EXISTS idx_hs_classifications_operation     ON tradeops.hs_classifications (trade_operation_id) WHERE trade_operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hs_classifications_tenant_review ON tradeops.hs_classifications (tenant_id, needs_review);
CREATE INDEX IF NOT EXISTS idx_hs_classifications_created_brin  ON tradeops.hs_classifications USING brin (created_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- ROW-LEVEL SECURITY — fail-closed tenant isolation on the audit table only
-- (mirrors migration 008/009/010/011). The two reference tables are global.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE tradeops.hs_classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE tradeops.hs_classifications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tradeops.hs_classifications;
CREATE POLICY tenant_isolation ON tradeops.hs_classifications
    USING ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)))
    WITH CHECK ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)));
