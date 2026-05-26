'use strict';
module.exports = (sequelize, DataTypes) => {
    const Deal = sequelize.define('Deal', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        tenant_id: { type: DataTypes.TEXT },
        rfq_id: { type: DataTypes.TEXT },
        buyer_org_id: { type: DataTypes.TEXT },
        seller_org_id: { type: DataTypes.TEXT },
        commodity: { type: DataTypes.STRING(255) },
        quantity: { type: DataTypes.DECIMAL(15, 4) },
        unit: { type: DataTypes.STRING(50) },
        unit_price: { type: DataTypes.DECIMAL(15, 4) },
        total_value: { type: DataTypes.DECIMAL(20, 2) },
        currency: { type: DataTypes.STRING(10), defaultValue: 'USD' },
        incoterm: { type: DataTypes.STRING(10) },
        origin: { type: DataTypes.STRING(255) },
        destination: { type: DataTypes.STRING(255) },
        payment_terms: { type: DataTypes.STRING(255) },
        last_message: { type: DataTypes.TEXT },
        status: {
            type: DataTypes.ENUM('draft', 'negotiation', 'finalized', 'committed', 'cancelled'),
            defaultValue: 'draft',
        },
        signed_at: { type: DataTypes.DATE },
        expires_at: { type: DataTypes.DATE },
    }, {
        schema: 'trade',
        tableName: 'deals',
        underscored: true,
        timestamps: true,
    });

    return Deal;
};
