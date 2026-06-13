'use strict';
// Compliance & Sanctions Engine (Prompt 8) — controlled-goods registry.
// Schema `tradeops`, GLOBAL reference data (no tenant_id → skipped by the tenant
// hooks in models/index.js). Restricted / dual-use / prohibited goods, matched on
// HS-code prefix and/or keyword, carrying the export-control regimes that apply.
// Seeded from service/compliance/dataset.js by seedCompliance.js.
module.exports = (sequelize, DataTypes) => {
    const ControlledGood = sequelize.define('ControlledGood', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        code: { type: DataTypes.TEXT, allowNull: false, unique: true },
        control_type: {
            type: DataTypes.TEXT,
            allowNull: false,
            defaultValue: 'restricted',
            validate: { isIn: [['restricted', 'dual_use', 'prohibited']] },
        },
        category: { type: DataTypes.TEXT, allowNull: false },
        description: { type: DataTypes.TEXT, allowNull: false },
        hs_prefixes: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false, defaultValue: [] },
        keywords: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false, defaultValue: [] },
        regimes: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        severity: {
            type: DataTypes.TEXT,
            allowNull: false,
            defaultValue: 'high',
            validate: { isIn: [['low', 'medium', 'high', 'critical']] },
        },
        license_required: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    }, {
        schema: 'tradeops',
        tableName: 'compliance_controlled_goods',
        underscored: true,
        timestamps: true,
    });

    return ControlledGood;
};
