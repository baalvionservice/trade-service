'use strict';
// HS Code Intelligence Engine (Prompt 7) — persisted classification run.
// Schema `tradeops`, UUID PK, tenant-scoped (RLS + index.js hooks). The full
// hs_suggestion_report JSON is stored verbatim in `report`; scalar columns are
// denormalized projections for cheap filtering / dashboard rollups. Append-only
// audit (no soft delete, no optimistic version) — re-classifying inserts a row.
module.exports = (sequelize, DataTypes) => {
    const HsClassification = sequelize.define('HsClassification', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        tenant_id: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'T-DEMO' },
        document_ref: { type: DataTypes.TEXT },        // caller product id / sku
        product_description: { type: DataTypes.TEXT },
        trade_operation_id: { type: DataTypes.UUID },
        destination_country: { type: DataTypes.TEXT },
        origin_country: { type: DataTypes.TEXT },
        suggested_code: { type: DataTypes.TEXT },
        national_code: { type: DataTypes.TEXT },
        method: {
            type: DataTypes.TEXT,
            validate: { isIn: [['exact', 'search', 'ai', 'fallback', 'manual']] },
        },
        confidence: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        confidence_band: { type: DataTypes.TEXT },
        needs_review: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        blocking: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        flag_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        duty_estimate: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        report: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        created_by: { type: DataTypes.TEXT },
    }, {
        schema: 'tradeops',
        tableName: 'hs_classifications',
        underscored: true,
        timestamps: true,
    });

    HsClassification.associate = (db) => {
        HsClassification.belongsTo(db.TradeOperation, { as: 'tradeOperation', foreignKey: 'trade_operation_id' });
    };

    return HsClassification;
};
