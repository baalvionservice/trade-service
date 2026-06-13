'use strict';
// HS Code Intelligence Engine (Prompt 7) — HS code catalogue.
// Schema `tradeops`, GLOBAL reference data (no tenant_id → skipped by the tenant
// hooks in models/index.js, like the shared `carriers` registry). Seeded from
// service/hscode/hsDatabase.js by seedHsCodes.js (single source of truth).
module.exports = (sequelize, DataTypes) => {
    const HsCode = sequelize.define('HsCode', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        hs_code: { type: DataTypes.TEXT, allowNull: false, unique: true },
        heading: { type: DataTypes.TEXT, allowNull: false },
        chapter: { type: DataTypes.TEXT, allowNull: false },
        description: { type: DataTypes.TEXT, allowNull: false },
        category: { type: DataTypes.TEXT },
        unit: { type: DataTypes.TEXT },
        keywords: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false, defaultValue: [] },
        controls: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    }, {
        schema: 'tradeops',
        tableName: 'hs_codes',
        underscored: true,
        timestamps: true,
    });

    HsCode.associate = (db) => {
        HsCode.hasMany(db.HsTariffLine, { as: 'tariffLines', sourceKey: 'hs_code', foreignKey: 'hs_code' });
    };

    return HsCode;
};
