'use strict';
module.exports = (sequelize, DataTypes) => {
    const Wallet = sequelize.define('Wallet', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        tenant_id: { type: DataTypes.TEXT },
        org_id: { type: DataTypes.INTEGER, allowNull: false, unique: true },
        balance: { type: DataTypes.DECIMAL(20, 6), defaultValue: 0 },
        reserved_balance: { type: DataTypes.DECIMAL(20, 6), defaultValue: 0 },
        currency: { type: DataTypes.STRING(10), defaultValue: 'USD' },
    }, {
        schema: 'trade',
        tableName: 'wallets',
        underscored: true,
        timestamps: true,
        updatedAt: 'updated_at',
        createdAt: false,
    });

    Wallet.associate = (db) => {
        Wallet.belongsTo(db.Organization, { foreignKey: 'org_id', as: 'organization' });
    };

    return Wallet;
};
