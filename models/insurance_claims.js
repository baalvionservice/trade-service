'use strict';
module.exports = (sequelize, DataTypes) => {
    // Insurance claim against a policy (Logistics #7). Lifecycle: filed → under_review → approved → paid
    // (or rejected). Payout composes the finance facade. Tenant-scoped.
    const InsuranceClaim = sequelize.define('InsuranceClaim', {
        id: { type: DataTypes.STRING(64), primaryKey: true }, // 'CLM-...'
        tenant_id: { type: DataTypes.TEXT },
        policy_id: { type: DataTypes.STRING(64) },
        shipment_id: { type: DataTypes.TEXT },
        claim_number: { type: DataTypes.STRING(80), unique: true },
        amount: { type: DataTypes.DECIMAL(20, 2), defaultValue: 0 },
        status: { type: DataTypes.STRING(20), defaultValue: 'filed' },
        reason: { type: DataTypes.TEXT },
        assessor: { type: DataTypes.STRING(120) },
        payout_amount: { type: DataTypes.DECIMAL(20, 2) },
        payout_ref: { type: DataTypes.STRING(120) },
        filed_at: { type: DataTypes.DATE },
        resolved_at: { type: DataTypes.DATE },
        paid_at: { type: DataTypes.DATE },
        metadata: { type: DataTypes.JSONB, defaultValue: {} },
    }, {
        schema: 'trade',
        tableName: 'insurance_claims',
        underscored: true,
        timestamps: true,
    });

    return InsuranceClaim;
};
