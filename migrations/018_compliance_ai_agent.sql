-- 018 — Compliance AI Agent (War Room 4, Prompt 13).
--
-- Persists the append-only audit of the Compliance AI Agent's assessments: each
-- run scans a shipment, fuses a deterministic rule layer (the Prompt 8 sanctions
-- engine) with a pluggable AI risk layer, and records the hybrid verdict —
-- decision, risk_score, confidence, the concrete findings, the reasoning chain
-- (explainability output) and the scanned signals.
--
-- NOTE on numbering: 009→017 are taken (tradeops foundation → dispatch). 018 keeps
-- this migration unambiguous on a clean rebuild.
--
-- One table in schema `tradeops`:
--   • compliance_assessments — TENANT-SCOPED, RLS, append-only audit of AI-agent
--                              risk assessments. Scalar columns are denormalized
--                              projections of `report` for cheap filtering /
--                              dashboard rollups; `report` is the full hybrid
--                              assessment (findings + explanation + signals).
--
-- Design guarantees (mirror 008/009/.../017):
--   • Tenant isolation — RLS fail-closed on the tenant-scoped table.
--   • migrate.js NOTE — splits on ";\n", so NO DO-blocks / multi-statement
--     function bodies; the RLS policy is written explicitly.

CREATE TABLE IF NOT EXISTS tradeops.compliance_assessments (
    id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           text          NOT NULL DEFAULT 'T-DEMO',
    shipment_id         uuid,
    trade_operation_id  uuid,
    subject_ref         text,
    decision            text          NOT NULL DEFAULT 'clear',
    risk_score          numeric(5,2)  NOT NULL DEFAULT 0,
    risk_level          text          NOT NULL DEFAULT 'minimal',
    severity            text          NOT NULL DEFAULT 'none',
    confidence          integer       NOT NULL DEFAULT 0,
    blocking            boolean       NOT NULL DEFAULT false,
    finding_count       integer       NOT NULL DEFAULT 0,
    rule_finding_count  integer       NOT NULL DEFAULT 0,
    ai_finding_count    integer       NOT NULL DEFAULT 0,
    origin_country      text,
    destination_country text,
    top_risks           jsonb         NOT NULL DEFAULT '[]'::jsonb,
    findings            jsonb         NOT NULL DEFAULT '[]'::jsonb,
    reasoning           jsonb         NOT NULL DEFAULT '[]'::jsonb,
    narrative           text,
    signals             jsonb         NOT NULL DEFAULT '[]'::jsonb,
    report              jsonb         NOT NULL DEFAULT '{}'::jsonb,
    model_provider      text,
    engine_version      text,
    trigger             text          NOT NULL DEFAULT 'manual',
    reason              text,
    created_by          text,
    created_at          timestamptz   NOT NULL DEFAULT now(),
    updated_at          timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT fk_compliance_assessments_shipment FOREIGN KEY (shipment_id) REFERENCES tradeops.shipments (id) ON DELETE SET NULL,
    CONSTRAINT fk_compliance_assessments_operation FOREIGN KEY (trade_operation_id) REFERENCES tradeops.trade_operations (id) ON DELETE SET NULL,
    CONSTRAINT chk_compliance_assessments_decision CHECK (decision IN ('clear','monitor','review','block')),
    CONSTRAINT chk_compliance_assessments_risk_level CHECK (risk_level IN ('minimal','low','moderate','high','critical')),
    CONSTRAINT chk_compliance_assessments_severity CHECK (severity IN ('none','low','medium','high','critical')),
    CONSTRAINT chk_compliance_assessments_trigger CHECK (trigger IN ('manual','api','workflow_transition','dispatch_gate','order','placement','scheduler','backfill')),
    CONSTRAINT chk_compliance_assessments_risk CHECK (risk_score >= 0 AND risk_score <= 100),
    CONSTRAINT chk_compliance_assessments_confidence CHECK (confidence >= 0 AND confidence <= 100)
);

CREATE INDEX IF NOT EXISTS idx_compliance_assessments_tenant_decision ON tradeops.compliance_assessments (tenant_id, decision);
CREATE INDEX IF NOT EXISTS idx_compliance_assessments_shipment        ON tradeops.compliance_assessments (shipment_id) WHERE shipment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_compliance_assessments_operation       ON tradeops.compliance_assessments (trade_operation_id) WHERE trade_operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_compliance_assessments_created_brin    ON tradeops.compliance_assessments USING brin (created_at);

ALTER TABLE tradeops.compliance_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE tradeops.compliance_assessments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tradeops.compliance_assessments;
CREATE POLICY tenant_isolation ON tradeops.compliance_assessments
    USING ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)))
    WITH CHECK ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)));
