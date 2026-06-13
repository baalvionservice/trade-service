'use strict';
// Logistics Optimization Agent (Prompt 14) — append-only optimization audit.
// One immutable row per optimization run / route selection behind a route
// optimization. Schema `tradeops`, tenant-scoped (RLS + index.js hooks).
// See migration 019 + service/logistics/logisticsEngine.js.
module.exports = (sequelize, DataTypes) => {
    const RouteOptimizationEvent = sequelize.define('RouteOptimizationEvent', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        tenant_id: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'T-DEMO' },
        optimization_id: { type: DataTypes.UUID, allowNull: false },
        event_type: { type: DataTypes.TEXT, allowNull: false }, // optimized / selected / failed
        strategy: { type: DataTypes.TEXT },
        message: { type: DataTypes.TEXT },
        detail: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        created_by: { type: DataTypes.TEXT },
    }, {
        schema: 'tradeops',
        tableName: 'route_optimization_events',
        underscored: true,
        timestamps: true,
        updatedAt: false, // append-only
    });

    RouteOptimizationEvent.associate = (db) => {
        if (db.RouteOptimization) {
            RouteOptimizationEvent.belongsTo(db.RouteOptimization, { as: 'optimization', foreignKey: 'optimization_id' });
        }
    };

    return RouteOptimizationEvent;
};
