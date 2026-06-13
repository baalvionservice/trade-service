'use strict';
// Trade Operations Cloud (War Room 4, Prompt 2) — webhook delivery record.
// One row per (transition × subscription). Created `pending`, advanced to
// `delivered` / `failed` / `dead` by the queue worker — an at-least-once,
// auditable delivery trail that survives process restarts.
module.exports = (sequelize, DataTypes) => {
    const WorkflowWebhookDelivery = sequelize.define('WorkflowWebhookDelivery', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        tenant_id: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'T-DEMO' },
        webhook_id: { type: DataTypes.UUID, allowNull: false },
        workflow_id: { type: DataTypes.UUID, allowNull: false },
        transition_id: { type: DataTypes.UUID },
        event: { type: DataTypes.TEXT, allowNull: false },
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
        tableName: 'workflow_webhook_deliveries',
        underscored: true,
        timestamps: true,
    });

    WorkflowWebhookDelivery.associate = (db) => {
        WorkflowWebhookDelivery.belongsTo(db.WorkflowWebhook, { as: 'webhook', foreignKey: 'webhook_id' });
        WorkflowWebhookDelivery.belongsTo(db.ShipmentWorkflow, { as: 'workflow', foreignKey: 'workflow_id' });
    };

    return WorkflowWebhookDelivery;
};
