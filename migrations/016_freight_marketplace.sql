-- 016 — Freight Marketplace Integration Layer (War Room 4, Prompt 10).
--
-- Persists carrier-connector-driven freight BOOKINGS across the marketplace
-- integrations (DHL / FedEx / UPS / Maersk) PLUS an append-only audit of every
-- quote, booking attempt, carrier FALLBACK and lifecycle transition.
--
-- NOTE on numbering: 009→015 are taken (tradeops foundation → customs gateway).
-- 016 keeps this migration unambiguous on a clean rebuild.
--
-- Two tables in schema `tradeops`:
--   • freight_bookings        — TENANT-SCOPED, RLS: the tracked booking. status walks
--                               booking → booked/failed → confirmed → in_transit →
--                               delivered/cancelled. The selected carrier + quote +
--                               tracking are the normalized projection of whichever
--                               carrier confirmed; `quotes` snapshots the full ranked
--                               marketplace; `carriers_attempted` records the fallback
--                               trail.
--   • freight_booking_events  — TENANT-SCOPED, RLS, append-only audit: one immutable
--                               row per quote/attempt/fallback/transition.
--
-- Design guarantees (mirror 008…015):
--   • Tenant isolation — RLS fail-closed on both tenant-scoped tables.
--   • migrate.js NOTE — splits on ";\n", so NO DO-blocks / multi-statement function
--     bodies; every RLS policy is written explicitly per table.

-- ─────────────────────────────────────────────────────────────────────────────
-- FREIGHT BOOKINGS (tenant-scoped, RLS) — the tracked booking lifecycle
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tradeops.freight_bookings (
    id                   uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            text          NOT NULL DEFAULT 'T-DEMO',
    order_id             text,
    shipment_id          uuid,
    trade_operation_id   uuid,
    carrier              text,
    service_level        text,
    mode                 text,
    status               text          NOT NULL DEFAULT 'booking',
    origin               jsonb         NOT NULL DEFAULT '{}'::jsonb,
    destination          jsonb         NOT NULL DEFAULT '{}'::jsonb,
    request              jsonb         NOT NULL DEFAULT '{}'::jsonb,
    quotes               jsonb         NOT NULL DEFAULT '[]'::jsonb,
    selected_quote       jsonb,
    chargeable_weight_kg numeric(20,3),
    amount               numeric(20,2),
    currency             text          NOT NULL DEFAULT 'USD',
    tracking_number      text,
    gateway_reference    text,
    label_url            text,
    estimated_delivery   text,
    carriers_attempted   jsonb         NOT NULL DEFAULT '[]'::jsonb,
    attempts             integer       NOT NULL DEFAULT 0,
    max_fallbacks        integer       NOT NULL DEFAULT 3,
    messages             jsonb         NOT NULL DEFAULT '[]'::jsonb,
    last_error           text,
    failure_kind         text,
    idempotency_key      text,
    engine_version       text,
    booked_at            timestamptz,
    completed_at         timestamptz,
    created_by           text,
    created_at           timestamptz   NOT NULL DEFAULT now(),
    updated_at           timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT fk_freight_bookings_trade_operation FOREIGN KEY (trade_operation_id) REFERENCES tradeops.trade_operations (id) ON DELETE SET NULL,
    CONSTRAINT chk_freight_bookings_carrier CHECK (carrier IS NULL OR carrier IN ('dhl','fedex','ups','maersk')),
    CONSTRAINT chk_freight_bookings_mode CHECK (mode IS NULL OR mode IN ('express','air','ocean','road')),
    CONSTRAINT chk_freight_bookings_status CHECK (status IN ('draft','booking','booked','confirmed','in_transit','delivered','cancelled','failed')),
    CONSTRAINT chk_freight_bookings_failure_kind CHECK (failure_kind IS NULL OR failure_kind IN ('validation','transient','permanent')),
    CONSTRAINT uq_freight_bookings_idem UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_freight_bookings_tenant_status ON tradeops.freight_bookings (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_freight_bookings_carrier       ON tradeops.freight_bookings (carrier) WHERE carrier IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_freight_bookings_shipment      ON tradeops.freight_bookings (shipment_id) WHERE shipment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_freight_bookings_order         ON tradeops.freight_bookings (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_freight_bookings_operation     ON tradeops.freight_bookings (trade_operation_id) WHERE trade_operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_freight_bookings_inflight      ON tradeops.freight_bookings (status, updated_at) WHERE status = 'booking';
CREATE INDEX IF NOT EXISTS idx_freight_bookings_created_brin  ON tradeops.freight_bookings USING brin (created_at);

ALTER TABLE tradeops.freight_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tradeops.freight_bookings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tradeops.freight_bookings;
CREATE POLICY tenant_isolation ON tradeops.freight_bookings
    USING ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)))
    WITH CHECK ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)));

-- ─────────────────────────────────────────────────────────────────────────────
-- FREIGHT BOOKING EVENTS (tenant-scoped, append-only audit, RLS)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tradeops.freight_booking_events (
    id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   text          NOT NULL DEFAULT 'T-DEMO',
    booking_id  uuid          NOT NULL,
    carrier     text,
    event_type  text          NOT NULL,
    status      text,
    attempt     integer,
    message     text,
    detail      jsonb         NOT NULL DEFAULT '{}'::jsonb,
    created_by  text,
    created_at  timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT fk_freight_booking_events_booking FOREIGN KEY (booking_id) REFERENCES tradeops.freight_bookings (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_freight_booking_events_booking ON tradeops.freight_booking_events (booking_id, created_at);
CREATE INDEX IF NOT EXISTS idx_freight_booking_events_tenant  ON tradeops.freight_booking_events (tenant_id);

ALTER TABLE tradeops.freight_booking_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE tradeops.freight_booking_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tradeops.freight_booking_events;
CREATE POLICY tenant_isolation ON tradeops.freight_booking_events
    USING ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)))
    WITH CHECK ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)));
