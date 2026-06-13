'use strict';
// Trade Operations Cloud (War Room 4, Prompt 2) — deterministic shipment workflow
// instance. Schema `tradeops`, UUID PK, tenant-scoped (RLS + index.js hooks),
// soft-deleted (paranoid), optimistic-locked (version) — the version column is
// what guards concurrent transitions from clobbering each other.
// See migrations/010_shipment_workflow_engine.sql and service/workflow/.
const { STATES, WORKFLOW_STATUSES } = require('../../service/workflow/stateMachine');

module.exports = (sequelize, DataTypes) => {
    const ShipmentWorkflow = sequelize.define('ShipmentWorkflow', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        tenant_id: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'T-DEMO' },
        reference_no: { type: DataTypes.TEXT, allowNull: false },
        shipment_id: { type: DataTypes.UUID },
        trade_operation_id: { type: DataTypes.UUID },
        current_state: {
            type: DataTypes.TEXT,
            allowNull: false,
            defaultValue: STATES.CREATED,
            validate: { isIn: [Object.values(STATES)] },
        },
        status: {
            type: DataTypes.TEXT,
            allowNull: false,
            defaultValue: 'active',
            validate: { isIn: [WORKFLOW_STATUSES] },
        },
        last_event: { type: DataTypes.TEXT },
        last_transition_at: { type: DataTypes.DATE },
        failure_reason: { type: DataTypes.TEXT },
        retry_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        created_by: { type: DataTypes.TEXT },
        updated_by: { type: DataTypes.TEXT },
        deleted_by: { type: DataTypes.TEXT },
    }, {
        schema: 'tradeops',
        tableName: 'shipment_workflows',
        underscored: true,
        timestamps: true,
        paranoid: true,
        deletedAt: 'deleted_at',
        version: true,
    });

    ShipmentWorkflow.associate = (db) => {
        ShipmentWorkflow.belongsTo(db.TradeShipment, { as: 'shipment', foreignKey: 'shipment_id' });
        ShipmentWorkflow.belongsTo(db.TradeOperation, { as: 'tradeOperation', foreignKey: 'trade_operation_id' });
        ShipmentWorkflow.hasMany(db.WorkflowTransition, { as: 'transitions', foreignKey: 'workflow_id' });
        ShipmentWorkflow.hasMany(db.WorkflowWebhookDelivery, { as: 'deliveries', foreignKey: 'workflow_id' });
    };

    return ShipmentWorkflow;
};
