-- 017 — Dispatch Orchestration Engine (War Room 4, Prompt 11).
--
-- The automation engine that fires a shipment's dispatch the moment its four
-- gates clear (documents validated, compliance passed, customs ready, freight
-- booked), via a rule engine, workflow-driven event triggers, a webhook system
-- and a saga-based failure-rollback system.
--
-- NOTE on numbering: 009→016 are taken (tradeops foundation → customs gateway →
-- freight marketplace). 017 keeps this migration unambiguous on a clean rebuild
-- and orders Prompt 11 (dispatch) after Prompt 10 (freight, 016).
--
-- Four tables in schema `tradeops`:
--   • dispatch_plans              — TENANT-SCOPED, RLS: the orchestration aggregate.
--                                   `conditions` jsonb is the gate-state map the rule
--                                   engine reads; `rule` is the normalized rule config;
--                                   status walks pending → ready → dispatching →
--                                   dispatched / rolled_back / failed / cancelled.
--   • dispatch_events             — TENANT-SCOPED, RLS, append-only audit: one
--                                   immutable row per gate signal / saga step /
--                                   compensation / outcome.
--   • dispatch_webhooks           — TENANT-SCOPED, RLS: webhook subscriptions.
--   • dispatch_webhook_deliveries — TENANT-SCOPED, RLS: per-(event × subscription)
--                                   signed-delivery trail (pending → delivered/failed).
--
-- Design guarantees (mirror 008→015):
--   • Tenant isolation — RLS fail-closed on all four tenant-scoped tables.
--   • migrate.js NOTE — splits on ";\n", so NO DO-blocks / multi-statement
--     function bodies; every RLS policy is written explicitly per table.

-- ─────────────────────────────────────────────────────────────────────────────
-- DISPATCH PLANS (tenant-scoped, RLS) — the orchestration aggregate
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tradeops.dispatch_plans (
    id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           text          NOT NULL DEFAULT 'T-DEMO',
    reference_no        text          NOT NULL,
    workflow_id         uuid,
    shipment_id         uuid,
    trade_operation_id  uuid,
    auto_dispatch       boolean       NOT NULL DEFAULT true,
    rule                jsonb         NOT NULL DEFAULT '{}'::jsonb,
    conditions          jsonb         NOT NULL DEFAULT '{}'::jsonb,
    dispatch_steps      jsonb         NOT NULL DEFAULT '[]'::jsonb,
    status              text          NOT NULL DEFAULT 'pending',
    version             integer       NOT NULL DEFAULT 1,
    failure_reason      text,
    dispatched_at       timestamptz,
    rolled_back_at      timestamptz,
    engine_version      text,
    metadata            jsonb         NOT NULL DEFAULT '{}'::jsonb,
    created_by          text,
    updated_by          text,
    deleted_by          text,
    created_at          timestamptz   NOT NULL DEFAULT now(),
    updated_at          timestamptz   NOT NULL DEFAULT now(),
    deleted_at          timestamptz,
    CONSTRAINT fk_dispatch_plans_workflow FOREIGN KEY (workflow_id) REFERENCES tradeops.shipment_workflows (id) ON DELETE SET NULL,
    CONSTRAINT fk_dispatch_plans_trade_operation FOREIGN KEY (trade_operation_id) REFERENCES tradeops.trade_operations (id) ON DELETE SET NULL,
    CONSTRAINT chk_dispatch_plans_status CHECK (status IN ('pending','ready','dispatching','dispatched','rolled_back','failed','cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_dispatch_plans_tenant_status ON tradeops.dispatch_plans (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_dispatch_plans_workflow      ON tradeops.dispatch_plans (workflow_id) WHERE workflow_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dispatch_plans_shipment      ON tradeops.dispatch_plans (shipment_id) WHERE shipment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dispatch_plans_operation     ON tradeops.dispatch_plans (trade_operation_id) WHERE trade_operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dispatch_plans_created_brin  ON tradeops.dispatch_plans USING brin (created_at);

ALTER TABLE tradeops.dispatch_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE tradeops.dispatch_plans FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tradeops.dispatch_plans;
CREATE POLICY tenant_isolation ON tradeops.dispatch_plans
    USING ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)))
    WITH CHECK ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)));

-- ─────────────────────────────────────────────────────────────────────────────
-- DISPATCH EVENTS (tenant-scoped, append-only audit, RLS)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tradeops.dispatch_events (
    id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       text          NOT NULL DEFAULT 'T-DEMO',
    plan_id         uuid          NOT NULL,
    seq             integer       NOT NULL DEFAULT 1,
    event_type      text          NOT NULL,
    step            text,
    condition       text,
    status          text,
    message         text,
    detail          jsonb         NOT NULL DEFAULT '{}'::jsonb,
    idempotency_key text,
    created_by      text,
    created_at      timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT fk_dispatch_events_plan FOREIGN KEY (plan_id) REFERENCES tradeops.dispatch_plans (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_dispatch_events_plan   ON tradeops.dispatch_events (plan_id, seq);
CREATE INDEX IF NOT EXISTS idx_dispatch_events_tenant ON tradeops.dispatch_events (tenant_id);
-- Dedupe replayed condition signals (e.g. a re-delivered workflow transition).
CREATE UNIQUE INDEX IF NOT EXISTS uq_dispatch_events_idem ON tradeops.dispatch_events (plan_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

ALTER TABLE tradeops.dispatch_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE tradeops.dispatch_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tradeops.dispatch_events;
CREATE POLICY tenant_isolation ON tradeops.dispatch_events
    USING ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)))
    WITH CHECK ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)));

-- ─────────────────────────────────────────────────────────────────────────────
-- DISPATCH WEBHOOKS (tenant-scoped, RLS) — subscriptions
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tradeops.dispatch_webhooks (
    id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     text          NOT NULL DEFAULT 'T-DEMO',
    url           text          NOT NULL,
    secret        text          NOT NULL,
    description   text,
    event_filters jsonb         NOT NULL DEFAULT '[]'::jsonb,
    active        boolean       NOT NULL DEFAULT true,
    metadata      jsonb         NOT NULL DEFAULT '{}'::jsonb,
    created_by    text,
    updated_by    text,
    deleted_by    text,
    created_at    timestamptz   NOT NULL DEFAULT now(),
    updated_at    timestamptz   NOT NULL DEFAULT now(),
    deleted_at    timestamptz
);

CREATE INDEX IF NOT EXISTS idx_dispatch_webhooks_tenant_active ON tradeops.dispatch_webhooks (tenant_id, active);

ALTER TABLE tradeops.dispatch_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tradeops.dispatch_webhooks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tradeops.dispatch_webhooks;
CREATE POLICY tenant_isolation ON tradeops.dispatch_webhooks
    USING ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)))
    WITH CHECK ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)));

-- ─────────────────────────────────────────────────────────────────────────────
-- DISPATCH WEBHOOK DELIVERIES (tenant-scoped, RLS) — delivery trail
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tradeops.dispatch_webhook_deliveries (
    id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        text          NOT NULL DEFAULT 'T-DEMO',
    webhook_id       uuid          NOT NULL,
    plan_id          uuid          NOT NULL,
    event_type       text          NOT NULL,
    status           text          NOT NULL DEFAULT 'pending',
    attempts         integer       NOT NULL DEFAULT 0,
    last_status_code integer,
    last_error       text,
    payload          jsonb         NOT NULL DEFAULT '{}'::jsonb,
    delivered_at     timestamptz,
    created_at       timestamptz   NOT NULL DEFAULT now(),
    updated_at       timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT fk_dispatch_deliveries_webhook FOREIGN KEY (webhook_id) REFERENCES tradeops.dispatch_webhooks (id) ON DELETE CASCADE,
    CONSTRAINT fk_dispatch_deliveries_plan FOREIGN KEY (plan_id) REFERENCES tradeops.dispatch_plans (id) ON DELETE CASCADE,
    CONSTRAINT chk_dispatch_deliveries_status CHECK (status IN ('pending','delivered','failed','dead'))
);

CREATE INDEX IF NOT EXISTS idx_dispatch_deliveries_plan    ON tradeops.dispatch_webhook_deliveries (plan_id, created_at);
CREATE INDEX IF NOT EXISTS idx_dispatch_deliveries_webhook ON tradeops.dispatch_webhook_deliveries (webhook_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_deliveries_pending ON tradeops.dispatch_webhook_deliveries (status, created_at) WHERE status = 'pending';

ALTER TABLE tradeops.dispatch_webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE tradeops.dispatch_webhook_deliveries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tradeops.dispatch_webhook_deliveries;
CREATE POLICY tenant_isolation ON tradeops.dispatch_webhook_deliveries
    USING ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)))
    WITH CHECK ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)));
