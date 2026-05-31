'use strict';
module.exports = (sequelize, DataTypes) => {
    // A freight quote computed by the quote engine for a specific order + carrier (tenant-scoped:
    // a buyer's quotes for their own order). Maps 1:1 to the frontend ShippingQuote shape.
    const FreightQuote = sequelize.define('FreightQuote', {
        id: { type: DataTypes.STRING(80), primaryKey: true }, // e.g. 'Q-<order>-<carrier>'
        tenant_id: { type: DataTypes.TEXT },
        order_id: { type: DataTypes.TEXT },
        carrier_id: { type: DataTypes.STRING(64) },
        carrier_name: { type: DataTypes.STRING(255) },
        mode: { type: DataTypes.STRING(20) }, // sea/air/road/rail
        price: { type: DataTypes.DECIMAL(20, 2) },
        currency: { type: DataTypes.STRING(10), defaultValue: 'USD' },
        estimated_days: { type: DataTypes.INTEGER },
        reliability: { type: DataTypes.INTEGER }, // 0-100
        status: {
            type: DataTypes.ENUM('quoted', 'selected', 'expired', 'booked'),
            defaultValue: 'quoted',
        },
        valid_until: { type: DataTypes.DATE },
        metadata: { type: DataTypes.JSONB, defaultValue: {} },
    }, {
        schema: 'trade',
        tableName: 'freight_quotes',
        underscored: true,
        timestamps: true,
    });

    return FreightQuote;
};
