'use strict';
// Dispatch Orchestration Engine (Prompt 11) — append-only orchestration audit.
// Schema `tradeops`, UUID PK, tenant-scoped. One immutable row per occurrence:
// created / condition_signal / evaluated / dispatch_started / step_completed /
// step_failed / rollback_started / step_compensated / dispatched / failed /
// rolled_back / cancelled / retry. The durable trail of how a plan reached its
// outcome (every gate signal, every saga step, every compensation). `seq` orders
// events within a plan; `idempotency_key` dedupes replayed condition signals
// (UNIQUE per plan). No updatedAt — events are immutable. See migration 017.
module.exports = (sequelize, DataTypes) => {
    const DispatchEvent = sequelize.define('DispatchEvent', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        tenant_id: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'T-DEMO' },
        plan_id: { type: DataTypes.UUID, allowNull: false },
        seq: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
        event_type: { type: DataTypes.TEXT, allowNull: false },
        step: { type: DataTypes.TEXT },
        condition: { type: DataTypes.TEXT },
        status: { type: DataTypes.TEXT },
        message: { type: DataTypes.TEXT },
        detail: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        idempotency_key: { type: DataTypes.TEXT },
        created_by: { type: DataTypes.TEXT },
    }, {
        schema: 'tradeops',
        tableName: 'dispatch_events',
        underscored: true,
        timestamps: true,
        updatedAt: false, // append-only — no updates
    });

    DispatchEvent.associate = (db) => {
        if (db.DispatchPlan) DispatchEvent.belongsTo(db.DispatchPlan, { as: 'plan', foreignKey: 'plan_id' });
    };

    return DispatchEvent;
};
