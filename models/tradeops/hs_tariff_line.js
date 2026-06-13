'use strict';
// HS Code Intelligence Engine (Prompt 7) — per-country tariff line (multi-country
// HS mapping). Schema `tradeops`, GLOBAL reference data (no tenant_id → skipped
// by the tenant hooks). Carries the national 8/10-digit code, duty/VAT rates and
// restriction object for one (hs_code, country) pair.
module.exports = (sequelize, DataTypes) => {
    const HsTariffLine = sequelize.define('HsTariffLine', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        hs_code: { type: DataTypes.TEXT, allowNull: false },
        country: { type: DataTypes.TEXT, allowNull: false },
        national_code: { type: DataTypes.TEXT },
        duty_rate: { type: DataTypes.DECIMAL(7, 3), allowNull: false, defaultValue: 0 },
        vat_rate: { type: DataTypes.DECIMAL(7, 3), allowNull: false, defaultValue: 0 },
        restrictions: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        effective_from: { type: DataTypes.DATEONLY },
    }, {
        schema: 'tradeops',
        tableName: 'hs_tariff_lines',
        underscored: true,
        timestamps: true,
        indexes: [{ unique: true, fields: ['hs_code', 'country'] }],
    });

    HsTariffLine.associate = (db) => {
        HsTariffLine.belongsTo(db.HsCode, { as: 'hsCode', targetKey: 'hs_code', foreignKey: 'hs_code' });
    };

    return HsTariffLine;
};
