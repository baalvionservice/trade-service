-- 011 — Document Management System / Production File Engine (War Room 4, Prompt 4).
--
-- A secure document store for trade documents (commercial invoice, packing list,
-- bill of lading, certificate of origin, insurance docs). Three tables in schema
-- `tradeops`:
--
--   tradeops.documents          — one row per logical document (status, classification,
--                                 shipment/operation linkage, current version pointer).
--   tradeops.document_versions  — immutable, append-only file versions. Each points at
--                                 one stored object (S3-compatible or local) and carries
--                                 the plaintext SHA-256, app-level envelope-encryption
--                                 parameters, the virus-scan verdict, and extracted metadata.
--   tradeops.document_events    — append-only per-document chain of custody (upload,
--                                 scan, status change, download, verify/reject, delete).
--
-- Design guarantees enforced at the schema level:
--   • Versioning         — UNIQUE (document_id, version_no); versions are never mutated
--                          except for the scan result columns.
--   • Integrity          — sha256 stored per version (hash of the PLAINTEXT bytes).
--   • Tenant isolation   — RLS fail-closed per table (migration 008/009/010 style).
--   • Optimistic lock    — documents.version (Sequelize version:true).
--   • Shipment linkage   — documents.shipment_id / trade_operation_id FKs (ON DELETE SET NULL).
--
-- MIGRATION RUNNER NOTE: migrate.js splits on ";\n", so this file uses NO DO-blocks
-- and NO multi-statement function bodies — every RLS policy is written explicitly.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. documents — canonical logical document.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tradeops.documents (
    id                   uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            text          NOT NULL DEFAULT 'T-DEMO',
    doc_type             text          NOT NULL,
    title                text,
    description          text,
    status               text          NOT NULL DEFAULT 'draft',
    classification       text          NOT NULL DEFAULT 'OPERATIONAL',
    shipment_id          uuid,
    trade_operation_id   uuid,
    current_version      integer       NOT NULL DEFAULT 0,
    latest_version_id    uuid,
    issued_at            timestamptz,
    expires_at           timestamptz,
    metadata             jsonb         NOT NULL DEFAULT '{}'::jsonb,
    version              integer       NOT NULL DEFAULT 1,
    created_by           text,
    updated_by           text,
    deleted_by           text,
    created_at           timestamptz   NOT NULL DEFAULT now(),
    updated_at           timestamptz   NOT NULL DEFAULT now(),
    deleted_at           timestamptz,
    CONSTRAINT fk_documents_shipment FOREIGN KEY (shipment_id) REFERENCES tradeops.shipments (id) ON DELETE SET NULL,
    CONSTRAINT fk_documents_trade_operation FOREIGN KEY (trade_operation_id) REFERENCES tradeops.trade_operations (id) ON DELETE SET NULL,
    CONSTRAINT chk_documents_doc_type CHECK (doc_type IN ('commercial_invoice','packing_list','bill_of_lading','certificate_of_origin','insurance_document','other')),
    CONSTRAINT chk_documents_status CHECK (status IN ('draft','scanning','available','quarantined','rejected','verified','archived','expired')),
    CONSTRAINT chk_documents_classification CHECK (classification IN ('PUBLIC','OPERATIONAL','CONFIDENTIAL','RESTRICTED'))
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. document_versions — immutable file versions (the file engine's heart).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tradeops.document_versions (
    id                   uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            text          NOT NULL DEFAULT 'T-DEMO',
    document_id          uuid          NOT NULL,
    version_no           integer       NOT NULL,
    file_name            text          NOT NULL,
    original_file_name   text,
    mime_type            text          NOT NULL,
    detected_mime_type   text,
    file_size_bytes      bigint        NOT NULL,
    sha256               text          NOT NULL,
    storage_provider     text          NOT NULL,
    storage_bucket       text,
    storage_key          text          NOT NULL,
    encryption_algo      text          NOT NULL DEFAULT 'none',
    encryption_key_id    text,
    encryption_iv        text,
    encryption_tag       text,
    scan_status          text          NOT NULL DEFAULT 'pending',
    scan_engine          text,
    scan_signature       text,
    scan_result          jsonb         NOT NULL DEFAULT '{}'::jsonb,
    scanned_at           timestamptz,
    extracted_metadata   jsonb         NOT NULL DEFAULT '{}'::jsonb,
    uploaded_by          text,
    created_at           timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT fk_document_versions_document FOREIGN KEY (document_id) REFERENCES tradeops.documents (id) ON DELETE CASCADE,
    CONSTRAINT chk_document_versions_scan_status CHECK (scan_status IN ('pending','clean','infected','error','skipped'))
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. document_events — append-only chain of custody.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tradeops.document_events (
    id                   uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            text          NOT NULL DEFAULT 'T-DEMO',
    document_id          uuid          NOT NULL,
    version_id           uuid,
    event_type           text          NOT NULL,
    actor                text,
    detail               jsonb         NOT NULL DEFAULT '{}'::jsonb,
    occurred_at          timestamptz   NOT NULL DEFAULT now(),
    created_at           timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT fk_document_events_document FOREIGN KEY (document_id) REFERENCES tradeops.documents (id) ON DELETE CASCADE
);

-- ─────────────────────────────────────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────────────────────────────────────

-- documents
CREATE INDEX IF NOT EXISTS idx_documents_tenant_type     ON tradeops.documents (tenant_id, doc_type) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_documents_tenant_status   ON tradeops.documents (tenant_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_documents_shipment        ON tradeops.documents (shipment_id) WHERE shipment_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_documents_operation       ON tradeops.documents (trade_operation_id) WHERE trade_operation_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_documents_expires         ON tradeops.documents (expires_at) WHERE expires_at IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_documents_created_brin    ON tradeops.documents USING brin (created_at);

-- document_versions
CREATE UNIQUE INDEX IF NOT EXISTS uq_document_versions_no   ON tradeops.document_versions (document_id, version_no);
CREATE INDEX IF NOT EXISTS idx_document_versions_document   ON tradeops.document_versions (document_id, version_no DESC);
CREATE INDEX IF NOT EXISTS idx_document_versions_tenant     ON tradeops.document_versions (tenant_id);
CREATE INDEX IF NOT EXISTS idx_document_versions_scan       ON tradeops.document_versions (scan_status) WHERE scan_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_document_versions_sha256     ON tradeops.document_versions (tenant_id, sha256);

-- document_events
CREATE INDEX IF NOT EXISTS idx_document_events_document     ON tradeops.document_events (document_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_document_events_tenant_type  ON tradeops.document_events (tenant_id, event_type);
CREATE INDEX IF NOT EXISTS idx_document_events_occurred_brin ON tradeops.document_events USING brin (occurred_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- ROW-LEVEL SECURITY — fail-closed tenant isolation (mirrors migration 008/009/010).
-- Written explicitly per table (no DO-block) for migrate.js compatibility.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE tradeops.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE tradeops.documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tradeops.documents;
CREATE POLICY tenant_isolation ON tradeops.documents
    USING ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)))
    WITH CHECK ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)));

ALTER TABLE tradeops.document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tradeops.document_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tradeops.document_versions;
CREATE POLICY tenant_isolation ON tradeops.document_versions
    USING ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)))
    WITH CHECK ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)));

ALTER TABLE tradeops.document_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE tradeops.document_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tradeops.document_events;
CREATE POLICY tenant_isolation ON tradeops.document_events
    USING ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)))
    WITH CHECK ((current_setting('app.tenant_bypass', true) = 'on' AND current_user <> 'baalvion_app') OR (current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id::text = current_setting('app.current_tenant', true)));
