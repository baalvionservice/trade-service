-- 019 — Logistics Optimization Agent (War Room 4, Prompt 14).
--
-- Persists route-optimization RUNS — carrier selection + multi-leg route
-- optimization + cost-vs-speed analysis — capturing the request, the ranked
-- candidate routes, the cheapest / fastest / balanced picks the optimizer produced,
-- and (after a caller selection) the committed route. Plus an append-only audit of
-- every optimization + selection.
--
-- NOTE on numbering: 009→018 are taken (tradeops foundation → dispatch orchestration
-- → compliance AI agent at 018). 019 keeps this migration unambiguous on a clean rebuild.
--
-- Two tables in schema `tradeops`:
--   • route_optimizations        — TENANT-SCOPED, RLS: the optimization run. status
--                                  walks optimized → selected (or failed). The three
--                                  picks (cheapest/fastest/balanced) are the optimizer's
--                                  normalized projection; `routes` snapshots the full
--                                  ranked candidate set; `selected_route` records the
--                                  committed choice that hands off to freight booking.
--   • route_optimization_events  — TENANT-SCOPED, RLS, append-only audit: one immutable
--                                  row per optimization / selection.
--
-- Design guarantees (mirror 008…017):
--   • Tenant isolation — RLS fail-closed on both tenant-scoped tables.
--   • migrate.js NOTE — splits on ";\n", so NO DO-blocks / multi-statement function
--     bodies; every RLS policy is written explicitly per table.

-- ─────────────────────────────────────────────────────────────────────────────
-- ROUTE OPTIMIZATIONS (tenant-scoped, RLS) — the optimization run
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tradeops.route_optimizations (
    id                   uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            text          NOT NULL DEFAULT 'T-DEMO',
    reference            text,
    order_id             text,
    shipment_id          uuid,
    trade_operation_id   uuid,
    origin               jsonb         NOT NULL DEFAULT '{}'::jsonb,
    destination          jsonb         NOT NULL DEFAULT '{}'::jsonb,
    origin_hub           text,
    destination_hub      text,
    weight_kg            numeric(20,3),
    request              jsonb         NOT NULL DEFAULT '{}'::jsonb,
    strategy             text,
    status               text          NOT NULL DEFAULT 'optimized',
    routes               jsonb         NOT NULL DEFAULT '[]'::jsonb,
    cheapest             jsonb,
    fastest              jsonb,
    balanced             jsonb,
    recommended          jsonb,
    selected_strategy    text,
    selected_route       jsonb,
    warnings             jsonb         NOT NULL DEFAULT '[]'::jsonb,
    weights              jsonb,
    engine_version       text,
    created_by           text,
    created_at           timestamptz   NOT NULL DEFAULT now(),
    updated_at           timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT fk_route_optimizations_trade_operation FOREIGN KEY (trade_operation_id) REFERENCES tradeops.trade_operations (id) ON DELETE SET NULL,
    CONSTRAINT chk_route_optimizations_strategy CHECK (strategy IS NULL OR strategy IN ('cheapest','fastest','balanced')),
    CONSTRAINT chk_route_optimizations_selected_strategy CHECK (selected_strategy IS NULL OR selected_strategy IN ('cheapest','fastest','balanced','explicit')),
    CONSTRAINT chk_route_optimizations_status CHECK (status IN ('optimized','selected','failed'))
);

CREATE INDEX IF NOT EXISTS idx_route_optimizations_tenant_status ON tradeops.route_optimizations (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_route_optimizations_shipment      ON tradeops.route_optimizations (shipment_id) WHERE shipment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_route_optimizations_order         ON tradeops.route_optimizations (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_route_optimizations_operation     ON tradeops.route_optimizations (trade_operation_id) WHERE trade_operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_route_optimizations_lane          ON tradeops.route_optimizations (origin_hub, destination_hub) WHERE origin_hub IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_route_optimizations_created_brin  ON tradeops.route_optimizations USING brin (created_at);

ALTER TABLE tradeops.route_optimizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tradeops.route_optimizations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tradeops.route_optimizations;
CREATE POLICY tenant_isolation ON tradeops.route_optimizations
    USING ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)))
    WITH CHECK ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)));

-- ─────────────────────────────────────────────────────────────────────────────
-- ROUTE OPTIMIZATION EVENTS (tenant-scoped, append-only audit, RLS)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tradeops.route_optimization_events (
    id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        text          NOT NULL DEFAULT 'T-DEMO',
    optimization_id  uuid          NOT NULL,
    event_type       text          NOT NULL,
    strategy         text,
    message          text,
    detail           jsonb         NOT NULL DEFAULT '{}'::jsonb,
    created_by       text,
    created_at       timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT fk_route_optimization_events_optimization FOREIGN KEY (optimization_id) REFERENCES tradeops.route_optimizations (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_route_optimization_events_optimization ON tradeops.route_optimization_events (optimization_id, created_at);
CREATE INDEX IF NOT EXISTS idx_route_optimization_events_tenant       ON tradeops.route_optimization_events (tenant_id);

ALTER TABLE tradeops.route_optimization_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE tradeops.route_optimization_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tradeops.route_optimization_events;
CREATE POLICY tenant_isolation ON tradeops.route_optimization_events
    USING ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)))
    WITH CHECK ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)));
