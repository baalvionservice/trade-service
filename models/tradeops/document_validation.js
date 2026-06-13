'use strict';
// AI Document Validation Engine (Prompt 5) — persisted validation report.
// Schema `tradeops`, UUID PK, tenant-scoped (RLS + index.js hooks). The full
// validation_report JSON is stored verbatim in `report`; the scalar columns are
// denormalized projections for cheap filtering / dashboard rollups.
module.exports = (sequelize, DataTypes) => {
    const DocumentValidation = sequelize.define('DocumentValidation', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        tenant_id: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'T-DEMO' },
        // The validated document — `document_ref` is its id (int or uuid as text)
        // and `document_kind` says which table it lives in.
        document_ref: { type: DataTypes.TEXT, allowNull: false },
        document_kind: {
            type: DataTypes.TEXT,
            allowNull: false,
            defaultValue: 'tradeops_document',
            validate: { isIn: [['tradeops_document', 'shipment_document', 'document', 'payload']] },
        },
        trade_operation_id: { type: DataTypes.UUID },
        doc_type: { type: DataTypes.TEXT },
        status: {
            type: DataTypes.TEXT,
            allowNull: false,
            defaultValue: 'passed',
            validate: { isIn: [['passed', 'passed_with_warnings', 'failed']] },
        },
        confidence: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        readiness_score: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 100 },
        readiness_delta: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        finding_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        critical_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        high_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        medium_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        low_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        engine_version: { type: DataTypes.TEXT },
        classification: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        report: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        created_by: { type: DataTypes.TEXT },
    }, {
        schema: 'tradeops',
        tableName: 'document_validations',
        underscored: true,
        timestamps: true,
        // Append-only audit of validation runs — no soft delete, no version.
    });

    DocumentValidation.associate = (db) => {
        DocumentValidation.belongsTo(db.TradeOperation, { as: 'tradeOperation', foreignKey: 'trade_operation_id' });
    };

    return DocumentValidation;
};
