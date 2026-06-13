'use strict';
// Customs Gateway Abstraction Layer (Prompt 9) — a tracked customs filing.
// Schema `tradeops`, UUID PK, tenant-scoped (RLS + index.js hooks). The status
// column walks the submission lifecycle (queued → submitting → submitted/accepted/
// rejected/failed/cancelled); the scalar gateway_* columns + normalized_response
// are the normalized projection of whichever government gateway (ICEGATE/ACE/CDS/
// Mirsal) answered. See migration 015 + service/customs/.
module.exports = (sequelize, DataTypes) => {
    const CustomsSubmission = sequelize.define('CustomsSubmission', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        tenant_id: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'T-DEMO' },
        customs_entry_id: { type: DataTypes.TEXT },     // legacy trade.customs_entries ref
        shipment_id: { type: DataTypes.UUID },
        trade_operation_id: { type: DataTypes.UUID },
        channel: {
            type: DataTypes.TEXT,
            allowNull: false,
            validate: { isIn: [['icegate', 'ace', 'eu_cds', 'mirsal']] },
        },
        direction: {
            type: DataTypes.TEXT,
            allowNull: false,
            defaultValue: 'import',
            validate: { isIn: [['import', 'export']] },
        },
        origin_country: { type: DataTypes.TEXT },
        destination_country: { type: DataTypes.TEXT },
        status: {
            type: DataTypes.TEXT,
            allowNull: false,
            defaultValue: 'queued',
            validate: { isIn: [['draft', 'queued', 'submitting', 'submitted', 'accepted', 'rejected', 'failed', 'cancelled']] },
        },
        attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        max_attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 3 },
        gateway_reference: { type: DataTypes.TEXT },    // gov reference (BE no / MRN / entry no)
        gateway_status: { type: DataTypes.TEXT },       // the gateway's NATIVE status code
        declaration: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        normalized_response: { type: DataTypes.JSONB },
        messages: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        last_error: { type: DataTypes.TEXT },
        failure_kind: {
            type: DataTypes.TEXT,
            validate: { isIn: [['validation', 'transient', 'permanent']] },
        },
        idempotency_key: { type: DataTypes.TEXT },
        engine_version: { type: DataTypes.TEXT },
        submitted_at: { type: DataTypes.DATE },
        completed_at: { type: DataTypes.DATE },
        created_by: { type: DataTypes.TEXT },
    }, {
        schema: 'tradeops',
        tableName: 'customs_submissions',
        underscored: true,
        timestamps: true,
    });

    CustomsSubmission.associate = (db) => {
        if (db.TradeOperation) {
            CustomsSubmission.belongsTo(db.TradeOperation, { as: 'tradeOperation', foreignKey: 'trade_operation_id' });
        }
        if (db.CustomsSubmissionEvent) {
            CustomsSubmission.hasMany(db.CustomsSubmissionEvent, { as: 'events', foreignKey: 'submission_id' });
        }
    };

    return CustomsSubmission;
};
