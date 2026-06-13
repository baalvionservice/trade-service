'use strict';
// Document Management System — append-only document lifecycle/access log (War Room 4,
// Prompt 4). Every meaningful action (created, version_uploaded, scan_completed,
// status_changed, downloaded, verified, rejected, deleted) is recorded here so the
// document has a complete, tenant-scoped chain of custody. Complements the global
// tamper-evident audit chain (utils/audit.js) with per-document granularity.
module.exports = (sequelize, DataTypes) => {
    const DocumentEvent = sequelize.define('DocumentEvent', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        tenant_id: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'T-DEMO' },
        document_id: { type: DataTypes.UUID, allowNull: false },
        version_id: { type: DataTypes.UUID },
        event_type: { type: DataTypes.TEXT, allowNull: false },
        actor: { type: DataTypes.TEXT },
        detail: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        occurred_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    }, {
        schema: 'tradeops',
        tableName: 'document_events',
        underscored: true,
        timestamps: true,
        updatedAt: false,
    });

    DocumentEvent.associate = (db) => {
        DocumentEvent.belongsTo(db.TradeDocument, { as: 'document', foreignKey: 'document_id' });
    };

    return DocumentEvent;
};
