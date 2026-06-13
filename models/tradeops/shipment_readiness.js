'use strict';
// Shipment Readiness Score Engine (War Room 4, Prompt 6) — persisted readiness
// snapshot. Schema `tradeops`, UUID PK, tenant-scoped (RLS + index.js hooks).
// The component breakdown + blockers are stored in JSONB; the scalar *_score
// columns are denormalized projections for cheap filtering / dashboard rollups.
// APPEND-ONLY time series: each recalculation inserts a new row; the latest row
// (by created_at) is the live score. See migrations/012 + service/readiness/.
module.exports = (sequelize, DataTypes) => {
    const ShipmentReadiness = sequelize.define('ShipmentReadiness', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        tenant_id: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'T-DEMO' },
        shipment_id: { type: DataTypes.UUID, allowNull: false },
        trade_operation_id: { type: DataTypes.UUID },
        workflow_id: { type: DataTypes.UUID },
        readiness_score: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
        compliance_score: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
        documentation_score: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
        logistics_score: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
        risk_score: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
        band: {
            type: DataTypes.TEXT,
            allowNull: false,
            defaultValue: 'low',
            validate: { isIn: [['high', 'medium', 'low']] },
        },
        capped: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        weights: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        components: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        blockers: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        blocker_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        engine_version: { type: DataTypes.TEXT },
        trigger: {
            type: DataTypes.TEXT,
            allowNull: false,
            defaultValue: 'manual',
            validate: { isIn: [['manual', 'api', 'workflow_transition', 'document_validation', 'shipment_status', 'scheduler', 'backfill']] },
        },
        reason: { type: DataTypes.TEXT },
        created_by: { type: DataTypes.TEXT },
    }, {
        schema: 'tradeops',
        tableName: 'shipment_readiness_scores',
        underscored: true,
        timestamps: true,
        // Append-only time series of readiness snapshots — no soft delete, no version.
    });

    ShipmentReadiness.associate = (db) => {
        ShipmentReadiness.belongsTo(db.TradeShipment, { as: 'shipment', foreignKey: 'shipment_id' });
        ShipmentReadiness.belongsTo(db.TradeOperation, { as: 'tradeOperation', foreignKey: 'trade_operation_id' });
    };

    return ShipmentReadiness;
};
