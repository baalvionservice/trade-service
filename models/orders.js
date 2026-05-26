'use strict';
module.exports = (sequelize, DataTypes) => {
    const Order = sequelize.define('Order', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        tenant_id: { type: DataTypes.TEXT },
        deal_id: { type: DataTypes.TEXT },
        buyer_org_id: { type: DataTypes.TEXT },
        seller_org_id: { type: DataTypes.TEXT },
        product: { type: DataTypes.STRING(255) },
        quantity: { type: DataTypes.DECIMAL(15, 4) },
        price: { type: DataTypes.DECIMAL(15, 4) },
        total_value: { type: DataTypes.DECIMAL(20, 2) },
        currency: { type: DataTypes.STRING(10), defaultValue: 'USD' },
        status: {
            type: DataTypes.ENUM('pending', 'confirmed', 'in_production', 'shipped', 'delivered', 'cancelled'),
            defaultValue: 'pending',
        },
        fulfillment_state: {
            type: DataTypes.ENUM('pending', 'production', 'shipped', 'delivered'),
            defaultValue: 'pending',
        },
        logistics_id: { type: DataTypes.TEXT },
        due_date: { type: DataTypes.DATE },
    }, {
        schema: 'trade',
        tableName: 'orders',
        underscored: true,
        timestamps: true,
    });

    Order.associate = (db) => {
        Order.hasMany(db.Escrow, { foreignKey: 'order_id', as: 'escrows' });
        Order.hasMany(db.Shipment, { foreignKey: 'order_id', as: 'shipments' });
        Order.hasMany(db.Payment, { foreignKey: 'order_id', as: 'payments' });
        Order.hasMany(db.Dispute, { foreignKey: 'order_id', as: 'disputes' });
    };

    return Order;
};
