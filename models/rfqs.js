'use strict';
module.exports = (sequelize, DataTypes) => {
    const Rfq = sequelize.define('Rfq', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        tenant_id: { type: DataTypes.TEXT },
        buyer_org_id: { type: DataTypes.INTEGER },
        title: { type: DataTypes.STRING(255) },
        commodity: { type: DataTypes.STRING(255) },
        quantity: { type: DataTypes.DECIMAL(15, 4) },
        unit: { type: DataTypes.STRING(50) },
        origin_country: { type: DataTypes.STRING(100) },
        destination_country: { type: DataTypes.STRING(100) },
        incoterm: {
            type: DataTypes.ENUM('EXW', 'FOB', 'CIF', 'DDP', 'DAP', 'FCA'),
        },
        required_delivery_date: { type: DataTypes.DATEONLY },
        budget_usd: { type: DataTypes.DECIMAL(15, 2) },
        status: {
            type: DataTypes.ENUM('draft', 'open', 'closed', 'awarded', 'cancelled'),
            defaultValue: 'open',
        },
        expires_at: { type: DataTypes.DATE },
    }, {
        schema: 'trade',
        tableName: 'rfqs',
        underscored: true,
        timestamps: true,
    });

    Rfq.associate = (db) => {
        Rfq.belongsTo(db.Organization, { foreignKey: 'buyer_org_id', as: 'buyer' });
    };

    return Rfq;
};
