-- 009 — Trade Operations Cloud foundation (War Room 4, Prompt 1).
--
-- A self-contained, production-grade multi-tenant Trade Operations module living
-- in its OWN schema `tradeops` so it never collides with the legacy
-- trade.shipments (INTEGER-PK, wired into the orders flow). Designed for 10M+
-- shipment_events scale.
--
-- Every table carries, by convention:
--   id          uuid PK  (gen_random_uuid — PG13+ core function)
--   tenant_id   text NOT NULL  -> Row-Level Security isolation (mandatory)
--   created_at / updated_at      -> managed by Sequelize (timestamps:true)
--   created_by / updated_by      -> audit attribution
--   deleted_at / deleted_by      -> soft delete (Sequelize paranoid mode)
--   version     integer          -> optimistic concurrency
--
-- NOTE ON THE MIGRATION RUNNER: migrate.js splits on ";\n", so this file
-- deliberately uses NO DO-blocks and NO multi-statement function bodies — every
-- RLS policy is written explicitly per table (the proven migration-007 style).

CREATE SCHEMA IF NOT EXISTS tradeops;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. trade_operations — the parent aggregate (a consignment / trade lifecycle).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tradeops.trade_operations (
    id                       uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                text          NOT NULL DEFAULT 'T-DEMO',
    reference_no             text          NOT NULL,
    order_id                 uuid,
    buyer_org_id             text,
    seller_org_id            text,
    commodity                text,
    hs_code                  text,
    incoterm                 text,
    origin_country           text,
    destination_country      text,
    status                   text          NOT NULL DEFAULT 'draft',
    priority                 text          NOT NULL DEFAULT 'normal',
    total_value              numeric(20,2),
    currency                 text,
    expected_start_date      date,
    expected_completion_date date,
    metadata                 jsonb         NOT NULL DEFAULT '{}'::jsonb,
    version                  integer       NOT NULL DEFAULT 1,
    created_by               text,
    updated_by               text,
    deleted_by               text,
    created_at               timestamptz   NOT NULL DEFAULT now(),
    updated_at               timestamptz   NOT NULL DEFAULT now(),
    deleted_at               timestamptz,
    CONSTRAINT chk_trade_operations_status CHECK (status IN ('draft','active','in_transit','on_hold','completed','cancelled')),
    CONSTRAINT chk_trade_operations_priority CHECK (priority IN ('low','normal','high','critical'))
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. shipments — physical movements under a trade operation.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tradeops.shipments (
    id                   uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            text          NOT NULL DEFAULT 'T-DEMO',
    trade_operation_id   uuid          NOT NULL,
    shipment_no          text          NOT NULL,
    carrier_id           text,
    carrier_name         text,
    mode                 text,
    tracking_number      text,
    vessel_name          text,
    voyage_no            text,
    container_no         text,
    bill_of_lading_no    text,
    origin_port          text,
    destination_port     text,
    origin_country       text,
    destination_country  text,
    status               text          NOT NULL DEFAULT 'booked',
    estimated_departure  timestamptz,
    actual_departure     timestamptz,
    estimated_arrival    timestamptz,
    actual_arrival       timestamptz,
    gross_weight_kg      numeric(16,3),
    volume_cbm           numeric(16,3),
    package_count        integer,
    declared_value       numeric(20,2),
    currency             text,
    incoterm             text,
    metadata             jsonb         NOT NULL DEFAULT '{}'::jsonb,
    version              integer       NOT NULL DEFAULT 1,
    created_by           text,
    updated_by           text,
    deleted_by           text,
    created_at           timestamptz   NOT NULL DEFAULT now(),
    updated_at           timestamptz   NOT NULL DEFAULT now(),
    deleted_at           timestamptz,
    CONSTRAINT fk_shipments_trade_operation FOREIGN KEY (trade_operation_id) REFERENCES tradeops.trade_operations (id) ON DELETE CASCADE,
    CONSTRAINT chk_shipments_status CHECK (status IN ('booked','picked_up','in_transit','port_processing','customs_clearance','customs_hold','released','out_for_delivery','delivered','delayed','re_routed','exception','cancelled')),
    CONSTRAINT chk_shipments_mode CHECK (mode IS NULL OR mode IN ('sea','air','road','rail','multimodal'))
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. shipment_events — granular tracking timeline (HIGH VOLUME: 10M+ rows).
--    Append-only. At production scale this becomes a RANGE-partitioned table on
--    occurred_at (monthly partitions) — see docs/TRADE_OPERATIONS_SCHEMA.md.
--    Until then a BRIN index on occurred_at keeps time-range scans cheap.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tradeops.shipment_events (
    id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         text          NOT NULL DEFAULT 'T-DEMO',
    shipment_id       uuid          NOT NULL,
    event_type        text          NOT NULL,
    event_code        text,
    description       text,
    location_name     text,
    location_country  text,
    latitude          numeric(9,6),
    longitude         numeric(9,6),
    occurred_at       timestamptz   NOT NULL DEFAULT now(),
    recorded_at       timestamptz   NOT NULL DEFAULT now(),
    source            text          NOT NULL DEFAULT 'manual',
    payload           jsonb         NOT NULL DEFAULT '{}'::jsonb,
    created_by        text,
    deleted_by        text,
    created_at        timestamptz   NOT NULL DEFAULT now(),
    updated_at        timestamptz   NOT NULL DEFAULT now(),
    deleted_at        timestamptz,
    CONSTRAINT fk_shipment_events_shipment FOREIGN KEY (shipment_id) REFERENCES tradeops.shipments (id) ON DELETE CASCADE,
    CONSTRAINT chk_shipment_events_source CHECK (source IN ('carrier','iot','manual','edi','system'))
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. shipment_documents — trade documents bound to a shipment / operation.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tradeops.shipment_documents (
    id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           text          NOT NULL DEFAULT 'T-DEMO',
    shipment_id         uuid          NOT NULL,
    trade_operation_id  uuid,
    doc_type            text          NOT NULL,
    title               text,
    file_name           text,
    mime_type           text,
    file_size_bytes     bigint,
    storage_provider    text,
    storage_ref         text,
    sha256              text,
    status              text          NOT NULL DEFAULT 'pending',
    issued_at           timestamptz,
    expires_at          timestamptz,
    metadata            jsonb         NOT NULL DEFAULT '{}'::jsonb,
    version             integer       NOT NULL DEFAULT 1,
    created_by          text,
    updated_by          text,
    deleted_by          text,
    created_at          timestamptz   NOT NULL DEFAULT now(),
    updated_at          timestamptz   NOT NULL DEFAULT now(),
    deleted_at          timestamptz,
    CONSTRAINT fk_shipment_documents_shipment FOREIGN KEY (shipment_id) REFERENCES tradeops.shipments (id) ON DELETE CASCADE,
    CONSTRAINT fk_shipment_documents_trade_operation FOREIGN KEY (trade_operation_id) REFERENCES tradeops.trade_operations (id) ON DELETE CASCADE,
    CONSTRAINT chk_shipment_documents_status CHECK (status IN ('pending','verified','rejected','expired'))
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. shipment_status_history — append-only status-transition ledger.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tradeops.shipment_status_history (
    id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    text          NOT NULL DEFAULT 'T-DEMO',
    shipment_id  uuid          NOT NULL,
    from_status  text,
    to_status    text          NOT NULL,
    reason       text,
    note         text,
    changed_by   text,
    changed_at   timestamptz   NOT NULL DEFAULT now(),
    metadata     jsonb         NOT NULL DEFAULT '{}'::jsonb,
    created_at   timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT fk_shipment_status_history_shipment FOREIGN KEY (shipment_id) REFERENCES tradeops.shipments (id) ON DELETE CASCADE
);

-- ─────────────────────────────────────────────────────────────────────────────
-- INDEXES — tuned for tenant-scoped list/detail/timeline access at 10M+ scale.
-- Partial indexes (WHERE deleted_at IS NULL) keep the hot active-row path lean;
-- BRIN indexes give near-free time-range pruning on append-only timelines.
-- ─────────────────────────────────────────────────────────────────────────────

-- trade_operations
CREATE UNIQUE INDEX IF NOT EXISTS uq_trade_operations_ref       ON tradeops.trade_operations (tenant_id, reference_no) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_trade_operations_tenant_status   ON tradeops.trade_operations (tenant_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_trade_operations_order           ON tradeops.trade_operations (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trade_operations_created_brin    ON tradeops.trade_operations USING brin (created_at);

-- shipments
CREATE UNIQUE INDEX IF NOT EXISTS uq_shipments_no               ON tradeops.shipments (tenant_id, shipment_no) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_shipments_tracking         ON tradeops.shipments (tenant_id, tracking_number) WHERE tracking_number IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_shipments_tenant_status          ON tradeops.shipments (tenant_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_shipments_operation              ON tradeops.shipments (trade_operation_id);
CREATE INDEX IF NOT EXISTS idx_shipments_eta                    ON tradeops.shipments (tenant_id, estimated_arrival) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_shipments_created_brin           ON tradeops.shipments USING brin (created_at);

-- shipment_events (highest cardinality)
CREATE INDEX IF NOT EXISTS idx_shipment_events_shipment_time    ON tradeops.shipment_events (shipment_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_shipment_events_tenant_type      ON tradeops.shipment_events (tenant_id, event_type);
CREATE INDEX IF NOT EXISTS idx_shipment_events_occurred_brin    ON tradeops.shipment_events USING brin (occurred_at);

-- shipment_documents
CREATE INDEX IF NOT EXISTS idx_shipment_documents_shipment      ON tradeops.shipment_documents (shipment_id);
CREATE INDEX IF NOT EXISTS idx_shipment_documents_operation     ON tradeops.shipment_documents (trade_operation_id) WHERE trade_operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shipment_documents_tenant_type   ON tradeops.shipment_documents (tenant_id, doc_type) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_shipment_documents_status        ON tradeops.shipment_documents (tenant_id, status) WHERE deleted_at IS NULL;

-- shipment_status_history
CREATE INDEX IF NOT EXISTS idx_shipment_status_history_ship     ON tradeops.shipment_status_history (shipment_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_shipment_status_history_tenant   ON tradeops.shipment_status_history (tenant_id, to_status);

-- ─────────────────────────────────────────────────────────────────────────────
-- ROW-LEVEL SECURITY — fail-closed tenant isolation (mandatory).
-- Mirrors migration 008: the app.tenant_bypass escape hatch is honoured ONLY for
-- roles that are NOT the runtime role 'baalvion_app', so an injection that flips
-- the bypass GUC on the runtime connection cannot defeat isolation. Written
-- explicitly per table (no DO-block) for migrate.js compatibility.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE tradeops.trade_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tradeops.trade_operations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tradeops.trade_operations;
CREATE POLICY tenant_isolation ON tradeops.trade_operations
    USING ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)))
    WITH CHECK ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)));

ALTER TABLE tradeops.shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE tradeops.shipments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tradeops.shipments;
CREATE POLICY tenant_isolation ON tradeops.shipments
    USING ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)))
    WITH CHECK ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)));

ALTER TABLE tradeops.shipment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE tradeops.shipment_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tradeops.shipment_events;
CREATE POLICY tenant_isolation ON tradeops.shipment_events
    USING ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)))
    WITH CHECK ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)));

ALTER TABLE tradeops.shipment_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE tradeops.shipment_documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tradeops.shipment_documents;
CREATE POLICY tenant_isolation ON tradeops.shipment_documents
    USING ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)))
    WITH CHECK ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)));

ALTER TABLE tradeops.shipment_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE tradeops.shipment_status_history FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tradeops.shipment_status_history;
CREATE POLICY tenant_isolation ON tradeops.shipment_status_history
    USING ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)))
    WITH CHECK ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)));
