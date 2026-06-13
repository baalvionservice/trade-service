'use strict';
// Customs Gateway Abstraction Layer (Prompt 9) — append-only submission audit.
// Schema `tradeops`, UUID PK, tenant-scoped. One immutable row per lifecycle
// transition (queued / attempt / submitted / accepted / rejected / failed / retry /
// recovered / cancelled) — the durable trail of how a filing reached its outcome,
// including every transmission attempt. No soft delete, no version (events are
// immutable once written). See migration 015.
module.exports = (sequelize, DataTypes) => {
    const CustomsSubmissionEvent = sequelize.define('CustomsSubmissionEvent', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        tenant_id: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'T-DEMO' },
        submission_id: { type: DataTypes.UUID, allowNull: false },
        channel: { type: DataTypes.TEXT },
        event_type: { type: DataTypes.TEXT, allowNull: false },
        status: { type: DataTypes.TEXT },
        attempt: { type: DataTypes.INTEGER },
        message: { type: DataTypes.TEXT },
        detail: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        created_by: { type: DataTypes.TEXT },
    }, {
        schema: 'tradeops',
        tableName: 'customs_submission_events',
        underscored: true,
        timestamps: true,
        updatedAt: false, // append-only — no updates
    });

    CustomsSubmissionEvent.associate = (db) => {
        if (db.CustomsSubmission) {
            CustomsSubmissionEvent.belongsTo(db.CustomsSubmission, { as: 'submission', foreignKey: 'submission_id' });
        }
    };

    return CustomsSubmissionEvent;
};
