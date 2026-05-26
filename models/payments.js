'use strict';
module.exports = (sequelize, DataTypes) => {
    const Payment = sequelize.define('Payment', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        tenant_id: { type: DataTypes.TEXT },
        order_id: { type: DataTypes.INTEGER },
        payer_org_id: { type: DataTypes.TEXT },
        payee_org_id: { type: DataTypes.TEXT },
        amount: { type: DataTypes.DECIMAL(20, 2) },
        currency: { type: DataTypes.STRING(10) },
        method: {
            type: DataTypes.ENUM('wire_transfer', 'letter_of_credit', 'escrow', 'open_account'),
            defaultValue: 'wire_transfer',
        },
        status: {
            type: DataTypes.ENUM('pending', 'processing', 'completed', 'failed', 'refunded'),
            defaultValue: 'pending',
        },
        provider_tx_id: { type: DataTypes.TEXT, unique: true },
        settled_at: { type: DataTypes.DATE },
        metadata: { type: DataTypes.JSONB, defaultValue: {} },
    }, {
        schema: 'trade',
        tableName: 'payments',
        underscored: true,
        timestamps: true,
    });

    return Payment;
};
