'use strict';
// Compliance & Sanctions Engine (Prompt 8) — tenant blacklist / whitelist entry.
// Schema `tradeops`, TENANT-SCOPED (RLS + index.js tenant hooks). A per-tenant
// override layered on top of the global reference data:
//   • blacklist — a tenant additionally DENIES this party/country/good/entity
//                 (a hard violation even if the global lists are clean).
//   • whitelist — a tenant explicitly ALLOWS a value the global lists would
//                 otherwise flag (the violation is recorded but de-escalated to
//                 informational, so it can never block this tenant's trade).
// See migration 014 + service/compliance/.
module.exports = (sequelize, DataTypes) => {
    const ComplianceListEntry = sequelize.define('ComplianceListEntry', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        tenant_id: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'T-DEMO' },
        list_type: {
            type: DataTypes.TEXT,
            allowNull: false,
            defaultValue: 'blacklist',
            validate: { isIn: [['blacklist', 'whitelist']] },
        },
        subject_type: {
            type: DataTypes.TEXT,
            allowNull: false,
            defaultValue: 'party',
            validate: { isIn: [['party', 'country', 'good', 'hs_code', 'entity']] },
        },
        value: { type: DataTypes.TEXT, allowNull: false },
        reason: { type: DataTypes.TEXT },
        severity: {
            type: DataTypes.TEXT,
            allowNull: false,
            defaultValue: 'high',
            validate: { isIn: [['low', 'medium', 'high', 'critical']] },
        },
        active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        expires_at: { type: DataTypes.DATE },
        created_by: { type: DataTypes.TEXT },
    }, {
        schema: 'tradeops',
        tableName: 'compliance_list_entries',
        underscored: true,
        timestamps: true,
    });

    return ComplianceListEntry;
};
