'use strict';
module.exports = (sequelize, DataTypes) => {
    const Shipment = sequelize.define('Shipment', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        tenant_id: { type: DataTypes.TEXT },
        order_id: { type: DataTypes.INTEGER },
        carrier_id: { type: DataTypes.TEXT },
        carrier_name: { type: DataTypes.STRING(255) },
        tracking_number: { type: DataTypes.STRING(255), unique: true },
        vessel_name: { type: DataTypes.STRING(255) },
        container_id: { type: DataTypes.STRING(100) },
        origin: { type: DataTypes.STRING(255) },
        destination: { type: DataTypes.STRING(255) },
        status: {
            type: DataTypes.ENUM(
                'booked', 'picked_up', 'in_transit', 'port_processing',
                'customs_clearance', 'customs_hold', 'released', 'delivered',
                'delayed', 're_routed', 'cancelled'
            ),
            defaultValue: 'booked',
        },
        estimated_arrival: { type: DataTypes.DATE },
        actual_arrival: { type: DataTypes.DATE },
        value: { type: DataTypes.DECIMAL(20, 2) },
        currency: { type: DataTypes.STRING(10) },
        milestones: { type: DataTypes.JSONB, defaultValue: [] },
        exceptions: { type: DataTypes.JSONB, defaultValue: [] },
        iot_stream_id: { type: DataTypes.TEXT },
    }, {
        schema: 'trade',
        tableName: 'shipments',
        underscored: true,
        timestamps: true,
    });

    return Shipment;
};
