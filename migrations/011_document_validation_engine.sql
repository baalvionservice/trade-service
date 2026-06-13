-- 011 — AI Document Validation Engine (Prompt 5).
--
-- Persists the validation_report produced when a trade document is checked for
-- quantity / weight / address / currency / tax mismatches and missing fields by
-- the deterministic rules engine + the pluggable AI classification layer.
--
-- Lives in schema `tradeops` (alongside 009/010). The full report JSON is stored
-- verbatim in `report`; the scalar columns are denormalized projections for
-- cheap filtering and dashboard rollups. This table is an APPEND-ONLY audit of
-- validation runs (no soft delete, no optimistic version) — re-validating a
-- document inserts a new row, preserving the history of every verdict.
--
-- Design guarantees (mirrors 008/009/010):
--   • Tenant isolation — RLS fail-closed.
--   • migrate.js NOTE — splits on ";\n", so NO DO-blocks / multi-statement
--     function bodies; every RLS policy is written explicitly per table.

CREATE TABLE IF NOT EXISTS tradeops.document_validations (
    id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           text          NOT NULL DEFAULT 'T-DEMO',
    document_ref        text          NOT NULL,
    document_kind       text          NOT NULL DEFAULT 'tradeops_document',
    trade_operation_id  uuid,
    doc_type            text,
    status              text          NOT NULL DEFAULT 'passed',
    confidence          integer       NOT NULL DEFAULT 0,
    readiness_score     numeric(5,2)  NOT NULL DEFAULT 100,
    readiness_delta     integer       NOT NULL DEFAULT 0,
    finding_count       integer       NOT NULL DEFAULT 0,
    critical_count      integer       NOT NULL DEFAULT 0,
    high_count          integer       NOT NULL DEFAULT 0,
    medium_count        integer       NOT NULL DEFAULT 0,
    low_count           integer       NOT NULL DEFAULT 0,
    engine_version      text,
    classification      jsonb         NOT NULL DEFAULT '{}'::jsonb,
    report              jsonb         NOT NULL DEFAULT '{}'::jsonb,
    created_by          text,
    created_at          timestamptz   NOT NULL DEFAULT now(),
    updated_at          timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT fk_document_validations_trade_operation FOREIGN KEY (trade_operation_id) REFERENCES tradeops.trade_operations (id) ON DELETE SET NULL,
    CONSTRAINT chk_document_validations_kind CHECK (document_kind IN ('tradeops_document','shipment_document','document','payload')),
    CONSTRAINT chk_document_validations_status CHECK (status IN ('passed','passed_with_warnings','failed')),
    CONSTRAINT chk_document_validations_confidence CHECK (confidence >= 0 AND confidence <= 100)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_document_validations_tenant_doc      ON tradeops.document_validations (tenant_id, document_kind, document_ref);
CREATE INDEX IF NOT EXISTS idx_document_validations_tenant_status   ON tradeops.document_validations (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_document_validations_operation       ON tradeops.document_validations (trade_operation_id) WHERE trade_operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_document_validations_created_brin    ON tradeops.document_validations USING brin (created_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- ROW-LEVEL SECURITY — fail-closed tenant isolation (mirrors migration 008/009/010).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE tradeops.document_validations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tradeops.document_validations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tradeops.document_validations;
CREATE POLICY tenant_isolation ON tradeops.document_validations
    USING ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)))
    WITH CHECK ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)));
