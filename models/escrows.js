'use strict';
module.exports = (sequelize, DataTypes) => {
    const Escrow = sequelize.define('Escrow', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        tenant_id: { type: DataTypes.TEXT },
        order_id: { type: DataTypes.INTEGER },
        buyer_org_id: { type: DataTypes.TEXT },
        seller_org_id: { type: DataTypes.TEXT },
        amount: { type: DataTypes.DECIMAL(20, 2) },
        currency: { type: DataTypes.STRING(10) },
        status: {
            type: DataTypes.ENUM('pending', 'funded', 'released', 'refunded', 'disputed'),
            defaultValue: 'pending',
        },
        funded_at: { type: DataTypes.DATE },
        released_at: { type: DataTypes.DATE },
        release_conditions: { type: DataTypes.JSONB, defaultValue: {} },
        mandate_hash: { type: DataTypes.TEXT },
    }, {
        schema: 'trade',
        tableName: 'escrows',
        underscored: true,
        timestamps: true,
    });

    return Escrow;
};
