'use strict';
// Compliance & Sanctions Engine (Prompt 8) — persisted screening snapshot.
// Schema `tradeops`, UUID PK, tenant-scoped (RLS + index.js hooks). Append-only
// audit: each screening run inserts a new row recording the decision
// (clear/review/block), the aggregate risk_score + overall severity, the concrete
// violations, the parties/goods screened and the KYC/AML hook verdicts. The
// scalar columns are denormalized projections of `report` for cheap filtering /
// dashboard rollups. See migration 014 + service/compliance/.
module.exports = (sequelize, DataTypes) => {
    const ComplianceScreening = sequelize.define('ComplianceScreening', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        tenant_id: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'T-DEMO' },
        subject_ref: { type: DataTypes.TEXT },
        trade_operation_id: { type: DataTypes.UUID },
        shipment_id: { type: DataTypes.UUID },
        decision: {
            type: DataTypes.TEXT,
            allowNull: false,
            defaultValue: 'clear',
            validate: { isIn: [['clear', 'review', 'block']] },
        },
        risk_score: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
        severity: {
            type: DataTypes.TEXT,
            allowNull: false,
            defaultValue: 'none',
            validate: { isIn: [['none', 'low', 'medium', 'high', 'critical']] },
        },
        violation_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        blocking: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        origin_country: { type: DataTypes.TEXT },
        destination_country: { type: DataTypes.TEXT },
        parties: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        goods: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        violations: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        checks: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        kyc_status: {
            type: DataTypes.TEXT,
            allowNull: false,
            defaultValue: 'not_checked',
            validate: { isIn: [['not_checked', 'pending', 'passed', 'failed', 'review']] },
        },
        aml_status: {
            type: DataTypes.TEXT,
            allowNull: false,
            defaultValue: 'not_checked',
            validate: { isIn: [['not_checked', 'pending', 'passed', 'failed', 'review']] },
        },
        report: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        engine_version: { type: DataTypes.TEXT },
        trigger: {
            type: DataTypes.TEXT,
            allowNull: false,
            defaultValue: 'manual',
            validate: { isIn: [['manual', 'api', 'workflow_transition', 'order', 'placement', 'scheduler', 'backfill']] },
        },
        reason: { type: DataTypes.TEXT },
        created_by: { type: DataTypes.TEXT },
    }, {
        schema: 'tradeops',
        tableName: 'compliance_screenings',
        underscored: true,
        timestamps: true,
        // Append-only audit of screening runs — no soft delete, no version.
    });

    ComplianceScreening.associate = (db) => {
        ComplianceScreening.belongsTo(db.TradeOperation, { as: 'tradeOperation', foreignKey: 'trade_operation_id' });
    };

    return ComplianceScreening;
};
