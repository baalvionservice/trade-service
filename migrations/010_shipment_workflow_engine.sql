-- 010 — Shipment Workflow State Machine (War Room 4, Prompt 2).
--
-- A deterministic, event-driven workflow engine that drives a shipment through
-- its lifecycle:
--   CREATED → DOCUMENT_COLLECTION → DOCUMENT_VERIFICATION → COMPLIANCE_CHECK →
--   HS_CLASSIFICATION → CUSTOMS_READY → FREIGHT_BOOKED → DISPATCH_READY →
--   DISPATCHED → IN_TRANSIT → DELIVERED → COMPLETED   (terminal: COMPLETED, FAILED)
--
-- Lives in schema `tradeops` (alongside migration 009). The workflow is a
-- SEPARATE layer from the physical tradeops.shipments.status (booked/in_transit/…):
-- it models the back-office orchestration stages, optionally bound to a shipment
-- and/or trade operation.
--
-- Design guarantees implemented here at the schema level:
--   • Idempotency       — UNIQUE (workflow_id, idempotency_key) on the event log.
--   • Optimistic lock   — shipment_workflows.version (Sequelize version:true).
--   • Append-only audit  — workflow_transitions is an immutable event log.
--   • Tenant isolation   — RLS fail-closed per table (migration 008/009 style).
--
-- MIGRATION RUNNER NOTE: migrate.js splits on ";\n", so this file uses NO
-- DO-blocks and NO multi-statement function bodies — every RLS policy is written
-- explicitly per table.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. shipment_workflows — one deterministic state-machine instance per shipment.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tradeops.shipment_workflows (
    id                   uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            text          NOT NULL DEFAULT 'T-DEMO',
    reference_no         text          NOT NULL,
    shipment_id          uuid,
    trade_operation_id   uuid,
    current_state        text          NOT NULL DEFAULT 'CREATED',
    status               text          NOT NULL DEFAULT 'active',
    last_event           text,
    last_transition_at   timestamptz,
    failure_reason       text,
    retry_count          integer       NOT NULL DEFAULT 0,
    metadata             jsonb         NOT NULL DEFAULT '{}'::jsonb,
    version              integer       NOT NULL DEFAULT 1,
    created_by           text,
    updated_by           text,
    deleted_by           text,
    created_at           timestamptz   NOT NULL DEFAULT now(),
    updated_at           timestamptz   NOT NULL DEFAULT now(),
    deleted_at           timestamptz,
    CONSTRAINT fk_shipment_workflows_shipment FOREIGN KEY (shipment_id) REFERENCES tradeops.shipments (id) ON DELETE SET NULL,
    CONSTRAINT fk_shipment_workflows_trade_operation FOREIGN KEY (trade_operation_id) REFERENCES tradeops.trade_operations (id) ON DELETE SET NULL,
    CONSTRAINT chk_shipment_workflows_state CHECK (current_state IN ('CREATED','DOCUMENT_COLLECTION','DOCUMENT_VERIFICATION','COMPLIANCE_CHECK','HS_CLASSIFICATION','CUSTOMS_READY','FREIGHT_BOOKED','DISPATCH_READY','DISPATCHED','IN_TRANSIT','DELIVERED','COMPLETED','FAILED')),
    CONSTRAINT chk_shipment_workflows_status CHECK (status IN ('active','completed','failed'))
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. workflow_transitions — append-only event log (every applied transition).
--    The UNIQUE idempotency key is what makes dispatch retry-safe: a replayed
--    request with the same key returns the already-recorded outcome.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tradeops.workflow_transitions (
    id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         text          NOT NULL DEFAULT 'T-DEMO',
    workflow_id       uuid          NOT NULL,
    seq               integer       NOT NULL,
    event             text          NOT NULL,
    from_state        text,
    to_state          text          NOT NULL,
    idempotency_key   text,
    actor             text,
    source            text          NOT NULL DEFAULT 'api',
    reason            text,
    payload           jsonb         NOT NULL DEFAULT '{}'::jsonb,
    occurred_at       timestamptz   NOT NULL DEFAULT now(),
    created_at        timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT fk_workflow_transitions_workflow FOREIGN KEY (workflow_id) REFERENCES tradeops.shipment_workflows (id) ON DELETE CASCADE,
    CONSTRAINT chk_workflow_transitions_source CHECK (source IN ('api','system','carrier','scheduler','webhook'))
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. workflow_webhooks — tenant-scoped subscriptions for transition events.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tradeops.workflow_webhooks (
    id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       text          NOT NULL DEFAULT 'T-DEMO',
    url             text          NOT NULL,
    secret          text          NOT NULL,
    description     text,
    event_filters   jsonb         NOT NULL DEFAULT '[]'::jsonb,
    active          boolean       NOT NULL DEFAULT true,
    metadata        jsonb         NOT NULL DEFAULT '{}'::jsonb,
    version         integer       NOT NULL DEFAULT 1,
    created_by      text,
    updated_by      text,
    deleted_by      text,
    created_at      timestamptz   NOT NULL DEFAULT now(),
    updated_at      timestamptz   NOT NULL DEFAULT now(),
    deleted_at      timestamptz
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. workflow_webhook_deliveries — per-(transition × subscription) delivery log.
--    Created pending, advanced to delivered/failed by the queue worker, giving an
--    at-least-once, retry-safe, auditable delivery record.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tradeops.workflow_webhook_deliveries (
    id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       text          NOT NULL DEFAULT 'T-DEMO',
    webhook_id      uuid          NOT NULL,
    workflow_id     uuid          NOT NULL,
    transition_id   uuid,
    event           text          NOT NULL,
    status          text          NOT NULL DEFAULT 'pending',
    attempts        integer       NOT NULL DEFAULT 0,
    last_status_code integer,
    last_error      text,
    payload         jsonb         NOT NULL DEFAULT '{}'::jsonb,
    delivered_at    timestamptz,
    created_at      timestamptz   NOT NULL DEFAULT now(),
    updated_at      timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT fk_workflow_webhook_deliveries_webhook FOREIGN KEY (webhook_id) REFERENCES tradeops.workflow_webhooks (id) ON DELETE CASCADE,
    CONSTRAINT fk_workflow_webhook_deliveries_workflow FOREIGN KEY (workflow_id) REFERENCES tradeops.shipment_workflows (id) ON DELETE CASCADE,
    CONSTRAINT chk_workflow_webhook_deliveries_status CHECK (status IN ('pending','delivered','failed','dead'))
);

-- ─────────────────────────────────────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────────────────────────────────────

-- shipment_workflows
CREATE UNIQUE INDEX IF NOT EXISTS uq_shipment_workflows_ref       ON tradeops.shipment_workflows (tenant_id, reference_no) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_shipment_workflows_shipment  ON tradeops.shipment_workflows (shipment_id) WHERE shipment_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_shipment_workflows_tenant_state    ON tradeops.shipment_workflows (tenant_id, current_state) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_shipment_workflows_tenant_status   ON tradeops.shipment_workflows (tenant_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_shipment_workflows_operation       ON tradeops.shipment_workflows (trade_operation_id) WHERE trade_operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shipment_workflows_created_brin    ON tradeops.shipment_workflows USING brin (created_at);

-- workflow_transitions (append-only; idempotency is the critical constraint)
CREATE UNIQUE INDEX IF NOT EXISTS uq_workflow_transitions_idem    ON tradeops.workflow_transitions (workflow_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_workflow_transitions_seq     ON tradeops.workflow_transitions (workflow_id, seq);
CREATE INDEX IF NOT EXISTS idx_workflow_transitions_workflow      ON tradeops.workflow_transitions (workflow_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_transitions_tenant_event  ON tradeops.workflow_transitions (tenant_id, event);
CREATE INDEX IF NOT EXISTS idx_workflow_transitions_occurred_brin ON tradeops.workflow_transitions USING brin (occurred_at);

-- workflow_webhooks
CREATE INDEX IF NOT EXISTS idx_workflow_webhooks_tenant_active    ON tradeops.workflow_webhooks (tenant_id, active) WHERE deleted_at IS NULL;

-- workflow_webhook_deliveries
CREATE INDEX IF NOT EXISTS idx_workflow_webhook_deliveries_wf     ON tradeops.workflow_webhook_deliveries (workflow_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_webhook_deliveries_hook   ON tradeops.workflow_webhook_deliveries (webhook_id, status);
CREATE INDEX IF NOT EXISTS idx_workflow_webhook_deliveries_status ON tradeops.workflow_webhook_deliveries (tenant_id, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- ROW-LEVEL SECURITY — fail-closed tenant isolation (mirrors migration 008/009).
-- Written explicitly per table (no DO-block) for migrate.js compatibility.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE tradeops.shipment_workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE tradeops.shipment_workflows FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tradeops.shipment_workflows;
CREATE POLICY tenant_isolation ON tradeops.shipment_workflows
    USING ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)))
    WITH CHECK ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)));

ALTER TABLE tradeops.workflow_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tradeops.workflow_transitions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tradeops.workflow_transitions;
CREATE POLICY tenant_isolation ON tradeops.workflow_transitions
    USING ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)))
    WITH CHECK ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)));

ALTER TABLE tradeops.workflow_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tradeops.workflow_webhooks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tradeops.workflow_webhooks;
CREATE POLICY tenant_isolation ON tradeops.workflow_webhooks
    USING ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)))
    WITH CHECK ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)));

ALTER TABLE tradeops.workflow_webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE tradeops.workflow_webhook_deliveries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tradeops.workflow_webhook_deliveries;
CREATE POLICY tenant_isolation ON tradeops.workflow_webhook_deliveries
    USING ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)))
    WITH CHECK ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)));
