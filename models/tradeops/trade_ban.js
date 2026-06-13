'use strict';
// Compliance & Sanctions Engine (Prompt 8) — country-specific trade-ban registry.
// Schema `tradeops`, GLOBAL reference data (no tenant_id → skipped by the tenant
// hooks in models/index.js). The country-specific rule mapping: a `jurisdiction`
// (the country imposing the ban, or GLOBAL) bans `direction` (export/import/both)
// trade with `counterparty_country` for a goods `category` / HS-prefix set.
// Seeded from service/compliance/dataset.js by seedCompliance.js.
module.exports = (sequelize, DataTypes) => {
    const TradeBan = sequelize.define('TradeBan', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        code: { type: DataTypes.TEXT, allowNull: false, unique: true },
        jurisdiction: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'GLOBAL' },
        direction: {
            type: DataTypes.TEXT,
            allowNull: false,
            defaultValue: 'both',
            validate: { isIn: [['export', 'import', 'both']] },
        },
        counterparty_country: { type: DataTypes.TEXT, allowNull: false, defaultValue: '*' },
        category: { type: DataTypes.TEXT, allowNull: false, defaultValue: '*' },
        hs_prefixes: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false, defaultValue: [] },
        description: { type: DataTypes.TEXT, allowNull: false },
        severity: {
            type: DataTypes.TEXT,
            allowNull: false,
            defaultValue: 'critical',
            validate: { isIn: [['low', 'medium', 'high', 'critical']] },
        },
        active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    }, {
        schema: 'tradeops',
        tableName: 'compliance_trade_bans',
        underscored: true,
        timestamps: true,
    });

    return TradeBan;
};
