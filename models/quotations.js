'use strict';
module.exports = (sequelize, DataTypes) => {
    // camelCase attributes + underscored:false so the JSON maps 1:1 to the
    // frontend RFQResponse type (the seller-bid / quotation ledger) with no adapter.
    const Quotation = sequelize.define('Quotation', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        tenantId: { type: DataTypes.STRING, allowNull: false, defaultValue: 'T-DEMO' },
        rfqId: { type: DataTypes.STRING, allowNull: false },
        sellerId: { type: DataTypes.STRING, defaultValue: 'COMP-102' },
        sellerName: { type: DataTypes.STRING, defaultValue: 'Institutional Seller' },
        price: { type: DataTypes.FLOAT },
        quantity: { type: DataTypes.FLOAT },
        currency: { type: DataTypes.STRING(8), defaultValue: 'USD' },
        deliveryTime: { type: DataTypes.STRING },
        message: { type: DataTypes.TEXT },
        trustScore: { type: DataTypes.INTEGER, defaultValue: 820 },
        status: {
            type: DataTypes.ENUM('pending', 'accepted', 'rejected'),
            defaultValue: 'pending',
        },
    }, {
        schema: 'trade',
        tableName: 'quotations',
        underscored: false,
        timestamps: true,
    });

    return Quotation;
};
