'use strict';
module.exports = (sequelize, DataTypes) => {
    // Trade insurance policy (Logistics #7): cargo / liability / credit / parametric cover. status is a
    // STRING aligned to the frontend vocab (pending=quoted, active=bound, claimed/expired/cancelled).
    const InsurancePolicy = sequelize.define('InsurancePolicy', {
        id: { type: DataTypes.STRING(64), primaryKey: true }, // 'INS-...'
        tenant_id: { type: DataTypes.TEXT },
        shipment_id: { type: DataTypes.TEXT },
        order_id: { type: DataTypes.TEXT },
        policy_number: { type: DataTypes.STRING(80), unique: true },
        insurance_type: { type: DataTypes.STRING(20), defaultValue: 'cargo' },
        status: { type: DataTypes.STRING(20), defaultValue: 'pending' },
        insured: { type: DataTypes.JSONB, defaultValue: {} },
        beneficiary: { type: DataTypes.JSONB, defaultValue: {} },
        provider: { type: DataTypes.STRING(120) },
        coverage_amount: { type: DataTypes.DECIMAL(20, 2), defaultValue: 0 },
        currency: { type: DataTypes.STRING(10), defaultValue: 'USD' },
        premium: { type: DataTypes.DECIMAL(20, 2), defaultValue: 0 },
        premium_rate: { type: DataTypes.DECIMAL(10, 5) },
        deductible: { type: DataTypes.DECIMAL(20, 2), defaultValue: 0 },
        coverage_terms: { type: DataTypes.JSONB, defaultValue: {} },
        parametric_trigger: { type: DataTypes.JSONB, defaultValue: null }, // {metric,threshold,payout}
        premium_payment_ref: { type: DataTypes.STRING(120) },
        start_date: { type: DataTypes.DATE },
        end_date: { type: DataTypes.DATE },
        bound_at: { type: DataTypes.DATE },
        metadata: { type: DataTypes.JSONB, defaultValue: {} },
    }, {
        schema: 'trade',
        tableName: 'insurance_policies',
        underscored: true,
        timestamps: true,
    });

    return InsurancePolicy;
};
