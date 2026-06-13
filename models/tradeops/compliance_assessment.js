'use strict';
// Compliance AI Agent (Prompt 13) — persisted assessment snapshot.
// Schema `tradeops`, UUID PK, tenant-scoped (RLS + index.js hooks). Append-only
// audit: each agent run inserts a new row recording the hybrid verdict
// (clear/monitor/review/block), the overall risk_score + confidence + risk_level,
// the fused findings, the reasoning chain (explainability output) and the scanned
// signals. The scalar columns are denormalized projections of `report` for cheap
// filtering / dashboard rollups. See migration 018 + service/complianceAgent/.
module.exports = (sequelize, DataTypes) => {
    const ComplianceAssessment = sequelize.define('ComplianceAssessment', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        tenant_id: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'T-DEMO' },
        shipment_id: { type: DataTypes.UUID },
        trade_operation_id: { type: DataTypes.UUID },
        subject_ref: { type: DataTypes.TEXT },
        decision: {
            type: DataTypes.TEXT,
            allowNull: false,
            defaultValue: 'clear',
            validate: { isIn: [['clear', 'monitor', 'review', 'block']] },
        },
        risk_score: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
        risk_level: {
            type: DataTypes.TEXT,
            allowNull: false,
            defaultValue: 'minimal',
            validate: { isIn: [['minimal', 'low', 'moderate', 'high', 'critical']] },
        },
        severity: {
            type: DataTypes.TEXT,
            allowNull: false,
            defaultValue: 'none',
            validate: { isIn: [['none', 'low', 'medium', 'high', 'critical']] },
        },
        confidence: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        blocking: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        finding_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        rule_finding_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        ai_finding_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        origin_country: { type: DataTypes.TEXT },
        destination_country: { type: DataTypes.TEXT },
        top_risks: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        findings: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        reasoning: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        narrative: { type: DataTypes.TEXT },
        signals: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        report: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        model_provider: { type: DataTypes.TEXT },
        engine_version: { type: DataTypes.TEXT },
        trigger: {
            type: DataTypes.TEXT,
            allowNull: false,
            defaultValue: 'manual',
            validate: { isIn: [['manual', 'api', 'workflow_transition', 'dispatch_gate', 'order', 'placement', 'scheduler', 'backfill']] },
        },
        reason: { type: DataTypes.TEXT },
        created_by: { type: DataTypes.TEXT },
    }, {
        schema: 'tradeops',
        tableName: 'compliance_assessments',
        underscored: true,
        timestamps: true,
        // Append-only audit of agent runs — no soft delete, no version.
    });

    ComplianceAssessment.associate = (db) => {
        ComplianceAssessment.belongsTo(db.TradeShipment, { as: 'shipment', foreignKey: 'shipment_id' });
        ComplianceAssessment.belongsTo(db.TradeOperation, { as: 'tradeOperation', foreignKey: 'trade_operation_id' });
    };

    return ComplianceAssessment;
};
