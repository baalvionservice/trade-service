'use strict';
module.exports = (sequelize, DataTypes) => {
    const Notification = sequelize.define('Notification', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        tenant_id: { type: DataTypes.TEXT },
        recipient_org_id: { type: DataTypes.TEXT },
        type: { type: DataTypes.STRING(100) },
        title: { type: DataTypes.STRING(255) },
        message: { type: DataTypes.TEXT },
        entity_type: { type: DataTypes.STRING(100) },
        entity_id: { type: DataTypes.TEXT },
        is_read: { type: DataTypes.BOOLEAN, defaultValue: false },
    }, {
        schema: 'trade',
        tableName: 'notifications',
        underscored: true,
        timestamps: true,
        updatedAt: false,
    });

    return Notification;
};
