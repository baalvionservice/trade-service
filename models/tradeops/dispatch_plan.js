'use strict';
// Dispatch Orchestration Engine (War Room 4, Prompt 11) — the orchestration
// aggregate. Schema `tradeops`, UUID PK, tenant-scoped (RLS + index.js hooks),
// soft-deleted (paranoid). The `conditions` jsonb is the gate-state map the rule
// engine reads; `rule` is the normalized rule config; `status` walks
// pending → ready → dispatching → dispatched / rolled_back / failed / cancelled.
// `version` is a manually-bumped optimistic counter (concurrency is enforced by
// SELECT … FOR UPDATE in the engine). `dispatch_steps` records the saga steps that
// completed (for a later manual rollback). See migration 017 + service/dispatch/.
const { STATUS, ALL_STATUSES, ENGINE_VERSION } = require('../../service/dispatch/schema');

module.exports = (sequelize, DataTypes) => {
    const DispatchPlan = sequelize.define('DispatchPlan', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        tenant_id: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'T-DEMO' },
        reference_no: { type: DataTypes.TEXT, allowNull: false },
        workflow_id: { type: DataTypes.UUID },          // tradeops.shipment_workflows ref (enables auto-advance)
        shipment_id: { type: DataTypes.UUID },
        trade_operation_id: { type: DataTypes.UUID },
        auto_dispatch: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        rule: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        conditions: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        dispatch_steps: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        status: {
            type: DataTypes.TEXT,
            allowNull: false,
            defaultValue: STATUS.PENDING,
            validate: { isIn: [ALL_STATUSES] },
        },
        version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
        failure_reason: { type: DataTypes.TEXT },
        dispatched_at: { type: DataTypes.DATE },
        rolled_back_at: { type: DataTypes.DATE },
        engine_version: { type: DataTypes.TEXT, defaultValue: ENGINE_VERSION },
        metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        created_by: { type: DataTypes.TEXT },
        updated_by: { type: DataTypes.TEXT },
        deleted_by: { type: DataTypes.TEXT },
    }, {
        schema: 'tradeops',
        tableName: 'dispatch_plans',
        underscored: true,
        timestamps: true,
        paranoid: true,
        deletedAt: 'deleted_at',
    });

    DispatchPlan.associate = (db) => {
        if (db.ShipmentWorkflow) DispatchPlan.belongsTo(db.ShipmentWorkflow, { as: 'workflow', foreignKey: 'workflow_id' });
        if (db.TradeOperation) DispatchPlan.belongsTo(db.TradeOperation, { as: 'tradeOperation', foreignKey: 'trade_operation_id' });
        if (db.DispatchEvent) DispatchPlan.hasMany(db.DispatchEvent, { as: 'events', foreignKey: 'plan_id' });
        if (db.DispatchWebhookDelivery) DispatchPlan.hasMany(db.DispatchWebhookDelivery, { as: 'deliveries', foreignKey: 'plan_id' });
    };

    return DispatchPlan;
};
