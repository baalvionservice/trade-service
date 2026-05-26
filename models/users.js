'use strict';
module.exports = (sequelize, DataTypes) => {
    const User = sequelize.define('User', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        email: { type: DataTypes.STRING(255), allowNull: false, unique: true },
        password_hash: { type: DataTypes.TEXT, allowNull: false },
        full_name: { type: DataTypes.STRING(255), defaultValue: '' },
        role: {
            type: DataTypes.ENUM('admin', 'operator', 'client'),
            defaultValue: 'operator',
        },
        is_active: { type: DataTypes.BOOLEAN, defaultValue: true },
    }, {
        schema: 'trade',
        tableName: 'users',
        underscored: true,
        timestamps: true,
    });
    return User;
};
