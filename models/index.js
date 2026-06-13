'use strict';
const { Sequelize } = require('sequelize');
const config = require('../config/appConfig');

const sequelize = new Sequelize(config.db.name, config.db.user, config.db.password, {
    host: config.db.host,
    port: config.db.port,
    dialect: 'postgres',
    logging: config.env === 'development' ? console.log : false,
    define: {
        underscored: true,
        freezeTableName: true,
    },
});

const db = {};
db.Sequelize = Sequelize;
db.sequelize = sequelize;

db.User            = require('./users')(sequelize, Sequelize.DataTypes);
db.Organization    = require('./organizations')(sequelize, Sequelize.DataTypes);
db.Rfq             = require('./rfqs')(sequelize, Sequelize.DataTypes);
db.Deal            = require('./deals')(sequelize, Sequelize.DataTypes);
db.Order           = require('./orders')(sequelize, Sequelize.DataTypes);
db.Escrow          = require('./escrows')(sequelize, Sequelize.DataTypes);
db.Shipment        = require('./shipments')(sequelize, Sequelize.DataTypes);
db.Document        = require('./documents')(sequelize, Sequelize.DataTypes);
db.Payment         = require('./payments')(sequelize, Sequelize.DataTypes);
db.ComplianceCase  = require('./compliance')(sequelize, Sequelize.DataTypes);
db.Dispute         = require('./disputes')(sequelize, Sequelize.DataTypes);
db.Wallet          = require('./wallets')(sequelize, Sequelize.DataTypes);
db.Notification    = require('./notifications')(sequelize, Sequelize.DataTypes);
db.Listing         = require('./listings')(sequelize, Sequelize.DataTypes);
db.Quotation       = require('./quotations')(sequelize, Sequelize.DataTypes);
db.Message         = require('./messages')(sequelize, Sequelize.DataTypes);
db.Collection      = require('./collections')(sequelize, Sequelize.DataTypes);
db.AuditLog        = require('./audit_logs')(sequelize, Sequelize.DataTypes);
db.RefreshToken    = require('./refresh_tokens')(sequelize, Sequelize.DataTypes);
db.Carrier         = require('./carriers')(sequelize, Sequelize.DataTypes);
db.FreightQuote    = require('./freight_quotes')(sequelize, Sequelize.DataTypes);
db.BillOfLading    = require('./bills_of_lading')(sequelize, Sequelize.DataTypes);
db.CustomsEntry    = require('./customs_entries')(sequelize, Sequelize.DataTypes);
db.CertificateOfOrigin = require('./certificates_of_origin')(sequelize, Sequelize.DataTypes);
db.CarbonFootprint = require('./carbon_footprints')(sequelize, Sequelize.DataTypes);
db.InsurancePolicy = require('./insurance_policies')(sequelize, Sequelize.DataTypes);
db.InsuranceClaim  = require('./insurance_claims')(sequelize, Sequelize.DataTypes);

// ── Trade Operations Cloud (War Room 4) — schema `tradeops`, UUID PKs ────────
// Registered as TradeShipment (not Shipment) to avoid colliding with the legacy
// trade.shipments model above. All five carry tenant_id, so the tenant hooks
// below auto-scope them (they are NOT in TENANT_EXCLUDED).
db.TradeOperation        = require('./tradeops/trade_operation')(sequelize, Sequelize.DataTypes);
db.TradeShipment         = require('./tradeops/shipment')(sequelize, Sequelize.DataTypes);
db.ShipmentEvent         = require('./tradeops/shipment_event')(sequelize, Sequelize.DataTypes);
db.ShipmentDocument      = require('./tradeops/shipment_document')(sequelize, Sequelize.DataTypes);
db.ShipmentStatusHistory = require('./tradeops/shipment_status_history')(sequelize, Sequelize.DataTypes);

// ── Shipment Workflow State Machine (War Room 4, Prompt 2) — schema `tradeops` ──
// Deterministic, event-driven lifecycle engine. All four carry tenant_id, so the
// tenant hooks below auto-scope them (they are NOT in TENANT_EXCLUDED).
db.ShipmentWorkflow        = require('./tradeops/shipment_workflow')(sequelize, Sequelize.DataTypes);
db.WorkflowTransition      = require('./tradeops/workflow_transition')(sequelize, Sequelize.DataTypes);
db.WorkflowWebhook         = require('./tradeops/workflow_webhook')(sequelize, Sequelize.DataTypes);
db.WorkflowWebhookDelivery = require('./tradeops/workflow_webhook_delivery')(sequelize, Sequelize.DataTypes);

// ── Document Management System (War Room 4, Prompt 4) — schema `tradeops` ──────
// Production file engine: canonical documents + immutable versions (S3/encryption/
// scan metadata) + per-document event log. All carry tenant_id → auto-scoped by the
// tenant hooks below (NOT in TENANT_EXCLUDED). Registered as TradeDocument to avoid
// colliding with the legacy db.Document (trade.documents, INTEGER PK).
db.TradeDocument   = require('./tradeops/document')(sequelize, Sequelize.DataTypes);
db.DocumentVersion = require('./tradeops/document_version')(sequelize, Sequelize.DataTypes);
db.DocumentEvent   = require('./tradeops/document_event')(sequelize, Sequelize.DataTypes);

// ── AI Document Validation Engine (Prompt 5) — schema `tradeops` ──────────────
// Append-only audit of document validation runs (quantity/weight/address/currency/
// tax mismatch + missing-field checks). Carries tenant_id → auto-scoped by the
// tenant hooks below (NOT in TENANT_EXCLUDED).
db.DocumentValidation = require('./tradeops/document_validation')(sequelize, Sequelize.DataTypes);

// ── Shipment Readiness Score Engine (Prompt 6) — schema `tradeops` ────────────
// Append-only time series of weighted readiness snapshots (readiness +
// compliance/documentation/logistics/risk component scores). Carries tenant_id →
// auto-scoped by the tenant hooks below (NOT in TENANT_EXCLUDED).
db.ShipmentReadiness = require('./tradeops/shipment_readiness')(sequelize, Sequelize.DataTypes);

// ── HS Code Intelligence Engine (Prompt 7) — schema `tradeops` ────────────────
// HsCode + HsTariffLine are GLOBAL reference data (no tenant_id → skipped by the
// tenant hooks below, like Carrier). HsClassification carries tenant_id → it IS
// auto-scoped by the tenant hooks (append-only audit of classification runs).
db.HsCode           = require('./tradeops/hs_code')(sequelize, Sequelize.DataTypes);
db.HsTariffLine     = require('./tradeops/hs_tariff_line')(sequelize, Sequelize.DataTypes);
db.HsClassification = require('./tradeops/hs_classification')(sequelize, Sequelize.DataTypes);

// ── Compliance & Sanctions Engine (Prompt 8) — schema `tradeops` ──────────────
// SanctionedParty / ControlledGood / TradeBan are GLOBAL reference data (no
// tenant_id → skipped by the tenant hooks below, like HsCode). ComplianceListEntry
// (tenant blacklist/whitelist) and ComplianceScreening (append-only audit of
// screening runs) carry tenant_id → they ARE auto-scoped by the tenant hooks.
db.SanctionedParty      = require('./tradeops/sanctioned_party')(sequelize, Sequelize.DataTypes);
db.ControlledGood       = require('./tradeops/controlled_good')(sequelize, Sequelize.DataTypes);
db.TradeBan             = require('./tradeops/trade_ban')(sequelize, Sequelize.DataTypes);
db.ComplianceListEntry  = require('./tradeops/compliance_list_entry')(sequelize, Sequelize.DataTypes);
db.ComplianceScreening  = require('./tradeops/compliance_screening')(sequelize, Sequelize.DataTypes);

// ── Customs Gateway Abstraction Layer (Prompt 9) — schema `tradeops` ──────────
// Connector-driven government-gateway filings (ICEGATE/ACE/CDS/Mirsal). Both carry
// tenant_id → auto-scoped by the tenant hooks below (NOT in TENANT_EXCLUDED).
// CustomsSubmission tracks the filing lifecycle; CustomsSubmissionEvent is the
// append-only attempt/transition audit.
db.CustomsSubmission      = require('./tradeops/customs_submission')(sequelize, Sequelize.DataTypes);
db.CustomsSubmissionEvent = require('./tradeops/customs_submission_event')(sequelize, Sequelize.DataTypes);

// ── Freight Marketplace Integration Layer (Prompt 10) — schema `tradeops` ─────
// Carrier-connector-driven freight bookings (DHL/FedEx/UPS/Maersk) + the carrier
// fallback workflow. Both carry tenant_id → auto-scoped by the tenant hooks below
// (NOT in TENANT_EXCLUDED). FreightBooking tracks the booking lifecycle;
// FreightBookingEvent is the append-only quote/attempt/fallback/transition audit.
db.FreightBooking      = require('./tradeops/freight_booking')(sequelize, Sequelize.DataTypes);
db.FreightBookingEvent = require('./tradeops/freight_booking_event')(sequelize, Sequelize.DataTypes);

// ── Dispatch Orchestration Engine (Prompt 11) — schema `tradeops` ─────────────
// Automation engine that fires dispatch when a shipment's four gates clear
// (documents validated / compliance passed / customs ready / freight booked) via a
// rule engine, workflow-driven event triggers, a webhook system and a saga-based
// failure-rollback system. DispatchPlan is the orchestration aggregate (gate-state
// + rule + status); DispatchEvent is the append-only audit; DispatchWebhook +
// DispatchWebhookDelivery are the webhook subscription + signed-delivery trail. All
// carry tenant_id → auto-scoped by the tenant hooks below (NOT in TENANT_EXCLUDED).
db.DispatchPlan            = require('./tradeops/dispatch_plan')(sequelize, Sequelize.DataTypes);
db.DispatchEvent           = require('./tradeops/dispatch_event')(sequelize, Sequelize.DataTypes);
db.DispatchWebhook         = require('./tradeops/dispatch_webhook')(sequelize, Sequelize.DataTypes);
db.DispatchWebhookDelivery = require('./tradeops/dispatch_webhook_delivery')(sequelize, Sequelize.DataTypes);

// ── Compliance AI Agent (Prompt 13) — schema `tradeops` ───────────────────────
// AI agent that scans a shipment, detects risks and explains its reasoning via a
// rule + AI hybrid over the Prompt 8 sanctions engine. ComplianceAssessment is the
// append-only audit of agent runs (decision / risk_score / confidence / fused
// findings / reasoning chain). Carries tenant_id → auto-scoped by the tenant hooks
// below (NOT in TENANT_EXCLUDED).
db.ComplianceAssessment    = require('./tradeops/compliance_assessment')(sequelize, Sequelize.DataTypes);

// ── Logistics Optimization Agent (Prompt 14) — schema `tradeops` ──────────────
// Route optimizer: carrier selection + multi-leg route optimization over a lane
// network + cost-vs-speed scoring → cheapest / fastest / balanced route. RouteOptimization
// is the persisted run (request + ranked candidates + the three picks + the committed
// route); RouteOptimizationEvent is the append-only optimize/select audit. Both carry
// tenant_id → auto-scoped by the tenant hooks below (NOT in TENANT_EXCLUDED).
db.RouteOptimization       = require('./tradeops/route_optimization')(sequelize, Sequelize.DataTypes);
db.RouteOptimizationEvent  = require('./tradeops/route_optimization_event')(sequelize, Sequelize.DataTypes);

Object.values(db).forEach(model => {
    if (model && model.associate) model.associate(db);
});

// ── Centralized multi-tenant isolation ──────────────────────────────────────
// Per-model hooks auto-inject the tenant filter on reads and stamp it on writes,
// using the request's AsyncLocalStorage context. Excludes User (auth/login is
// pre-tenant) and AuditLog (single global hash chain).
const { currentTenant } = require('../middleware/tenantContext');
// Excluded from blunt single-tenant scoping:
//  - User/AuditLog: auth is pre-tenant; audit is a single global hash chain.
//  - Listing/Rfq: marketplace + discovery are cross-tenant by design.
//  - Deal/Quotation/Message: buyer↔seller dual-party negotiation (visible to
//    both orgs) — these need participant-based authorization, not a tenant_id
//    filter (tracked as a follow-up). Organization is shared counterparty data.
// Everything else (Order/Escrow/Shipment/Document/Payment/ComplianceCase/
// Dispute/Wallet/Notification/Collection) is a private single-owner record and
// IS tenant-scoped.
const TENANT_EXCLUDED = new Set([
    'User', 'AuditLog', 'Sequelize', 'sequelize',
    'Listing', 'Rfq', 'Deal', 'Quotation', 'Message', 'Organization',
    // Carrier: shared logistics marketplace (global registry, no tenant_id) — like Listing.
    'Carrier',
    // RefreshToken: auth/session management is pre-tenant and scoped by user_id
    // explicitly (the refresh endpoint has no valid access token / tenant ctx).
    'RefreshToken',
]);

const tenantAttr = (model) => {
    const a = model.rawAttributes || {};
    if (a.tenant_id) return 'tenant_id';
    if (a.tenantId) return 'tenantId';
    return null;
};

Object.entries(db).forEach(([name, model]) => {
    if (TENANT_EXCLUDED.has(name) || !model || typeof model.addHook !== 'function') return;
    const attr = tenantAttr(model);
    if (!attr) return;

    // Reads: inject tenant filter unless caller is a super-admin (bypass) or
    // the query already constrains the tenant attribute explicitly.
    model.addHook('beforeFind', (options) => {
        const ctx = currentTenant();
        if (!ctx || ctx.bypass || !ctx.tenantId) return;
        options.where = options.where || {};
        if (options.where[attr] === undefined) options.where[attr] = ctx.tenantId;
    });

    // Writes: stamp the tenant on create when not explicitly set.
    model.addHook('beforeCreate', (instance) => {
        const ctx = currentTenant();
        if (!ctx || ctx.bypass || !ctx.tenantId) return;
        if (instance[attr] == null) instance[attr] = ctx.tenantId;
    });
    model.addHook('beforeBulkCreate', (instances) => {
        const ctx = currentTenant();
        if (!ctx || ctx.bypass || !ctx.tenantId) return;
        instances.forEach((i) => { if (i[attr] == null) i[attr] = ctx.tenantId; });
    });

    // Bulk update/destroy: constrain to the caller's tenant.
    const scopeBulk = (options) => {
        const ctx = currentTenant();
        if (!ctx || ctx.bypass || !ctx.tenantId) return;
        options.where = options.where || {};
        if (options.where[attr] === undefined) options.where[attr] = ctx.tenantId;
    };
    model.addHook('beforeBulkUpdate', scopeBulk);
    model.addHook('beforeBulkDestroy', scopeBulk);
});

module.exports = db;
