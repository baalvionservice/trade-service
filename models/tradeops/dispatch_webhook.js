'use strict';
// Dispatch Orchestration Engine (Prompt 11) — webhook subscription. A tenant
// registers a URL + signing secret and an optional event filter list; every
// matching dispatch lifecycle event (condition_signal / ready / dispatched /
// rolled_back / failed / cancelled) fans out a signed POST (retry-safe via the
// `dispatch_webhook` queue). Schema `tradeops`, tenant-scoped, soft-deleted.
// Mirrors models/tradeops/workflow_webhook.js. See migration 017.
module.exports = (sequelize, DataTypes) => {
    const DispatchWebhook = sequelize.define('DispatchWebhook', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        tenant_id: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'T-DEMO' },
        url: { type: DataTypes.TEXT, allowNull: false },
        secret: { type: DataTypes.TEXT, allowNull: false },
        description: { type: DataTypes.TEXT },
        // [] = subscribe to ALL events. Otherwise an allowlist of event names
        // ("dispatched", "ready", "rolled_back") and/or "status:failed" pseudo-events.
        event_filters: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        created_by: { type: DataTypes.TEXT },
        updated_by: { type: DataTypes.TEXT },
        deleted_by: { type: DataTypes.TEXT },
    }, {
        schema: 'tradeops',
        tableName: 'dispatch_webhooks',
        underscored: true,
        timestamps: true,
        paranoid: true,
        deletedAt: 'deleted_at',
        defaultScope: { attributes: { exclude: ['secret'] } }, // never leak the secret on reads
        scopes: { withSecret: {} },
    });

    DispatchWebhook.associate = (db) => {
        if (db.DispatchWebhookDelivery) DispatchWebhook.hasMany(db.DispatchWebhookDelivery, { as: 'deliveries', foreignKey: 'webhook_id' });
    };

    return DispatchWebhook;
};
