'use strict';
// Trade Operations Cloud (War Room 4, Prompt 2) — append-only workflow event log.
// Immutable once written: no updated_at, no soft delete, no optimistic version.
// The UNIQUE (workflow_id, idempotency_key) index (migration 010) is the
// retry-safety primitive — a replayed dispatch with the same key collides and the
// engine returns the already-recorded transition instead of advancing twice.
module.exports = (sequelize, DataTypes) => {
    const WorkflowTransition = sequelize.define('WorkflowTransition', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        tenant_id: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'T-DEMO' },
        workflow_id: { type: DataTypes.UUID, allowNull: false },
        seq: { type: DataTypes.INTEGER, allowNull: false },
        event: { type: DataTypes.TEXT, allowNull: false },
        from_state: { type: DataTypes.TEXT },
        to_state: { type: DataTypes.TEXT, allowNull: false },
        idempotency_key: { type: DataTypes.TEXT },
        actor: { type: DataTypes.TEXT },
        source: {
            type: DataTypes.TEXT,
            allowNull: false,
            defaultValue: 'api',
            validate: { isIn: [['api', 'system', 'carrier', 'scheduler', 'webhook']] },
        },
        reason: { type: DataTypes.TEXT },
        payload: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        occurred_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    }, {
        schema: 'tradeops',
        tableName: 'workflow_transitions',
        underscored: true,
        timestamps: false, // append-only; created_at managed explicitly
    });

    WorkflowTransition.associate = (db) => {
        WorkflowTransition.belongsTo(db.ShipmentWorkflow, { as: 'workflow', foreignKey: 'workflow_id' });
    };

    return WorkflowTransition;
};
