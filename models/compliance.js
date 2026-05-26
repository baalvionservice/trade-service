'use strict';
module.exports = (sequelize, DataTypes) => {
    const ComplianceCase = sequelize.define('ComplianceCase', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        tenant_id: { type: DataTypes.TEXT },
        entity_type: { type: DataTypes.STRING(100) },
        entity_id: { type: DataTypes.TEXT },
        case_type: {
            type: DataTypes.ENUM(
                'sanctions_check', 'kyc_review', 'aml_screening',
                'customs_violation', 'trade_restriction'
            ),
            defaultValue: 'kyc_review',
        },
        status: {
            type: DataTypes.ENUM('open', 'under_review', 'cleared', 'escalated', 'closed'),
            defaultValue: 'open',
        },
        risk_level: {
            type: DataTypes.ENUM('low', 'medium', 'high', 'critical'),
            defaultValue: 'low',
        },
        assigned_to: { type: DataTypes.TEXT },
        findings: { type: DataTypes.TEXT },
        resolved_at: { type: DataTypes.DATE },
    }, {
        schema: 'trade',
        tableName: 'compliance_cases',
        underscored: true,
        timestamps: true,
    });

    return ComplianceCase;
};
