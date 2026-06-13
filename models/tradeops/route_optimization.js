'use strict';
// Logistics Optimization Agent (Prompt 14) — a persisted route-optimization run.
// Schema `tradeops`, UUID PK, tenant-scoped (RLS + index.js hooks). Captures the
// optimization request, the ranked candidate routes, the cheapest / fastest /
// balanced picks the optimizer produced, and (after a selection) the committed route.
// `status` walks optimized → selected (or failed). See migration 019 + service/logistics/.
module.exports = (sequelize, DataTypes) => {
    const RouteOptimization = sequelize.define('RouteOptimization', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        tenant_id: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'T-DEMO' },
        reference: { type: DataTypes.TEXT },
        order_id: { type: DataTypes.TEXT },
        shipment_id: { type: DataTypes.UUID },
        trade_operation_id: { type: DataTypes.UUID },
        origin: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        destination: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        origin_hub: { type: DataTypes.TEXT },
        destination_hub: { type: DataTypes.TEXT },
        weight_kg: { type: DataTypes.DECIMAL(20, 3) },
        request: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        strategy: {
            type: DataTypes.TEXT,
            validate: { isIn: [['cheapest', 'fastest', 'balanced']] },
        },
        status: {
            type: DataTypes.TEXT,
            allowNull: false,
            defaultValue: 'optimized',
            validate: { isIn: [['optimized', 'selected', 'failed']] },
        },
        routes: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },  // ranked candidate snapshot
        cheapest: { type: DataTypes.JSONB },                                     // the three picks
        fastest: { type: DataTypes.JSONB },
        balanced: { type: DataTypes.JSONB },
        recommended: { type: DataTypes.JSONB },
        selected_strategy: { type: DataTypes.TEXT },                             // set on selection
        selected_route: { type: DataTypes.JSONB },
        warnings: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        weights: { type: DataTypes.JSONB },
        engine_version: { type: DataTypes.TEXT },
        created_by: { type: DataTypes.TEXT },
    }, {
        schema: 'tradeops',
        tableName: 'route_optimizations',
        underscored: true,
        timestamps: true,
    });

    RouteOptimization.associate = (db) => {
        if (db.TradeOperation) {
            RouteOptimization.belongsTo(db.TradeOperation, { as: 'tradeOperation', foreignKey: 'trade_operation_id' });
        }
        if (db.RouteOptimizationEvent) {
            RouteOptimization.hasMany(db.RouteOptimizationEvent, { as: 'events', foreignKey: 'optimization_id' });
        }
    };

    return RouteOptimization;
};
