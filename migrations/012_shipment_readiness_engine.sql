-- 012 — Shipment Readiness Score Engine (War Room 4, Prompt 6).
--
-- Persists the weighted readiness snapshot computed for a shipment: a single
-- 0–100 readiness_score plus the four component scores (compliance,
-- documentation, logistics, risk), the band, the weights used and the concrete
-- blockers. Each recalculation INSERTS a new snapshot, so the table is an
-- APPEND-ONLY time series of a shipment's readiness — the latest row (by
-- created_at) is the live score, and the history powers trend/audit.
--
-- Lives in schema `tradeops` (alongside 009/010/011). Recalculation is
-- event-triggered: a workflow transition, a document validation, a shipment
-- status change or an explicit API call each enqueue a fresh snapshot. The
-- `trigger` column records what caused each recalculation.
--
-- Design guarantees (mirror 008/009/010/011):
--   • Tenant isolation — RLS fail-closed.
--   • migrate.js NOTE — splits on ";\n", so NO DO-blocks / multi-statement
--     function bodies; every RLS policy is written explicitly per table.

CREATE TABLE IF NOT EXISTS tradeops.shipment_readiness_scores (
    id                   uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            text          NOT NULL DEFAULT 'T-DEMO',
    shipment_id          uuid          NOT NULL,
    trade_operation_id   uuid,
    workflow_id          uuid,
    readiness_score      numeric(5,2)  NOT NULL DEFAULT 0,
    compliance_score     numeric(5,2)  NOT NULL DEFAULT 0,
    documentation_score  numeric(5,2)  NOT NULL DEFAULT 0,
    logistics_score      numeric(5,2)  NOT NULL DEFAULT 0,
    risk_score           numeric(5,2)  NOT NULL DEFAULT 0,
    band                 text          NOT NULL DEFAULT 'low',
    capped               boolean       NOT NULL DEFAULT false,
    weights              jsonb         NOT NULL DEFAULT '{}'::jsonb,
    components           jsonb         NOT NULL DEFAULT '{}'::jsonb,
    blockers             jsonb         NOT NULL DEFAULT '[]'::jsonb,
    blocker_count        integer       NOT NULL DEFAULT 0,
    engine_version       text,
    trigger              text          NOT NULL DEFAULT 'manual',
    reason               text,
    created_by           text,
    created_at           timestamptz   NOT NULL DEFAULT now(),
    updated_at           timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT fk_shipment_readiness_shipment FOREIGN KEY (shipment_id) REFERENCES tradeops.shipments (id) ON DELETE CASCADE,
    CONSTRAINT fk_shipment_readiness_trade_operation FOREIGN KEY (trade_operation_id) REFERENCES tradeops.trade_operations (id) ON DELETE SET NULL,
    CONSTRAINT chk_shipment_readiness_band CHECK (band IN ('high','medium','low')),
    CONSTRAINT chk_shipment_readiness_trigger CHECK (trigger IN ('manual','api','workflow_transition','document_validation','shipment_status','scheduler','backfill')),
    CONSTRAINT chk_shipment_readiness_score CHECK (readiness_score >= 0 AND readiness_score <= 100)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────────────────────────────────────
-- The hot path is "latest snapshot for this shipment" — (shipment_id, created_at DESC).
CREATE INDEX IF NOT EXISTS idx_shipment_readiness_shipment_latest ON tradeops.shipment_readiness_scores (shipment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shipment_readiness_tenant_band     ON tradeops.shipment_readiness_scores (tenant_id, band);
CREATE INDEX IF NOT EXISTS idx_shipment_readiness_operation       ON tradeops.shipment_readiness_scores (trade_operation_id) WHERE trade_operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shipment_readiness_created_brin    ON tradeops.shipment_readiness_scores USING brin (created_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- ROW-LEVEL SECURITY — fail-closed tenant isolation (mirrors migration 008/009/010/011).
-- Written explicitly (no DO-block) for migrate.js compatibility.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE tradeops.shipment_readiness_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE tradeops.shipment_readiness_scores FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tradeops.shipment_readiness_scores;
CREATE POLICY tenant_isolation ON tradeops.shipment_readiness_scores
    USING ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)))
    WITH CHECK ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)));
