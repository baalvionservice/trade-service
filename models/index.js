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
