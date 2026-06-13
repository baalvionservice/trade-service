'use strict';
// Trade Operations Cloud (War Room 4, Prompt 2) — webhook subscription. A tenant
// registers a URL + signing secret and an optional event/state filter list; every
// matching workflow transition fans out a signed POST (retry-safe via the queue).
// Schema `tradeops`, tenant-scoped, soft-deleted, optimistic-locked.
module.exports = (sequelize, DataTypes) => {
    const WorkflowWebhook = sequelize.define('WorkflowWebhook', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        tenant_id: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'T-DEMO' },
        url: { type: DataTypes.TEXT, allowNull: false },
        secret: { type: DataTypes.TEXT, allowNull: false },
        description: { type: DataTypes.TEXT },
        // [] = subscribe to ALL events. Otherwise an allowlist of event names
        // ("dispatch") and/or "entered:STATE" / "status:failed" pseudo-events.
        event_filters: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        created_by: { type: DataTypes.TEXT },
        updated_by: { type: DataTypes.TEXT },
        deleted_by: { type: DataTypes.TEXT },
    }, {
        schema: 'tradeops',
        tableName: 'workflow_webhooks',
        underscored: true,
        timestamps: true,
        paranoid: true,
        deletedAt: 'deleted_at',
        version: true,
        defaultScope: { attributes: { exclude: ['secret'] } }, // never leak the secret on reads
        scopes: { withSecret: {} },
    });

    WorkflowWebhook.associate = (db) => {
        WorkflowWebhook.hasMany(db.WorkflowWebhookDelivery, { as: 'deliveries', foreignKey: 'webhook_id' });
    };

    return WorkflowWebhook;
};
