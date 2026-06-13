'use strict';
// Trade Operations Cloud — shipment tracking event (append-only, high volume).
// No optimistic-lock version: events are immutable once written.
module.exports = (sequelize, DataTypes) => {
    const ShipmentEvent = sequelize.define('ShipmentEvent', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        tenant_id: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'T-DEMO' },
        shipment_id: { type: DataTypes.UUID, allowNull: false },
        event_type: { type: DataTypes.TEXT, allowNull: false },
        event_code: { type: DataTypes.TEXT },
        description: { type: DataTypes.TEXT },
        location_name: { type: DataTypes.TEXT },
        location_country: { type: DataTypes.TEXT },
        latitude: { type: DataTypes.DECIMAL(9, 6) },
        longitude: { type: DataTypes.DECIMAL(9, 6) },
        occurred_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        recorded_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        source: {
            type: DataTypes.TEXT,
            allowNull: false,
            defaultValue: 'manual',
            validate: { isIn: [['carrier', 'iot', 'manual', 'edi', 'system']] },
        },
        payload: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        created_by: { type: DataTypes.TEXT },
        deleted_by: { type: DataTypes.TEXT },
    }, {
        schema: 'tradeops',
        tableName: 'shipment_events',
        underscored: true,
        timestamps: true,
        paranoid: true,
        deletedAt: 'deleted_at',
    });

    ShipmentEvent.associate = (db) => {
        ShipmentEvent.belongsTo(db.TradeShipment, { as: 'shipment', foreignKey: 'shipment_id' });
    };

    return ShipmentEvent;
};
