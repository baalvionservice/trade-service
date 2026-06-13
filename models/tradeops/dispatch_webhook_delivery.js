'use strict';
// Dispatch Orchestration Engine (Prompt 11) — webhook delivery record. One row
// per (lifecycle event × subscription). Created `pending`, advanced to
// `delivered` / `failed` by the `dispatch_webhook` queue worker — an
// at-least-once, auditable delivery trail that survives process restarts.
// Mirrors models/tradeops/workflow_webhook_delivery.js. See migration 017.
module.exports = (sequelize, DataTypes) => {
    const DispatchWebhookDelivery = sequelize.define('DispatchWebhookDelivery', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        tenant_id: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'T-DEMO' },
        webhook_id: { type: DataTypes.UUID, allowNull: false },
        plan_id: { type: DataTypes.UUID, allowNull: false },
        event_type: { type: DataTypes.TEXT, allowNull: false },
        status: {
            type: DataTypes.TEXT,
            allowNull: false,
            defaultValue: 'pending',
            validate: { isIn: [['pending', 'delivered', 'failed', 'dead']] },
        },
        attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        last_status_code: { type: DataTypes.INTEGER },
        last_error: { type: DataTypes.TEXT },
        payload: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        delivered_at: { type: DataTypes.DATE },
    }, {
        schema: 'tradeops',
        tableName: 'dispatch_webhook_deliveries',
        underscored: true,
        timestamps: true,
    });

    DispatchWebhookDelivery.associate = (db) => {
        if (db.DispatchWebhook) DispatchWebhookDelivery.belongsTo(db.DispatchWebhook, { as: 'webhook', foreignKey: 'webhook_id' });
        if (db.DispatchPlan) DispatchWebhookDelivery.belongsTo(db.DispatchPlan, { as: 'plan', foreignKey: 'plan_id' });
    };

    return DispatchWebhookDelivery;
};
