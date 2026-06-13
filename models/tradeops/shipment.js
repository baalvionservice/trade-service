'use strict';
// Trade Operations Cloud — shipment (physical movement) under a trade operation.
// Registered as db.TradeShipment to avoid colliding with the legacy db.Shipment
// (trade.shipments, INTEGER PK). Schema `tradeops`, UUID PK, paranoid, versioned.
module.exports = (sequelize, DataTypes) => {
    const Shipment = sequelize.define('TradeShipment', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        tenant_id: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'T-DEMO' },
        trade_operation_id: { type: DataTypes.UUID, allowNull: false },
        shipment_no: { type: DataTypes.TEXT, allowNull: false },
        carrier_id: { type: DataTypes.TEXT },
        carrier_name: { type: DataTypes.TEXT },
        mode: {
            type: DataTypes.TEXT,
            validate: { isIn: [['sea', 'air', 'road', 'rail', 'multimodal']] },
        },
        tracking_number: { type: DataTypes.TEXT },
        vessel_name: { type: DataTypes.TEXT },
        voyage_no: { type: DataTypes.TEXT },
        container_no: { type: DataTypes.TEXT },
        bill_of_lading_no: { type: DataTypes.TEXT },
        origin_port: { type: DataTypes.TEXT },
        destination_port: { type: DataTypes.TEXT },
        origin_country: { type: DataTypes.TEXT },
        destination_country: { type: DataTypes.TEXT },
        status: {
            type: DataTypes.TEXT,
            allowNull: false,
            defaultValue: 'booked',
            validate: {
                isIn: [[
                    'booked', 'picked_up', 'in_transit', 'port_processing',
                    'customs_clearance', 'customs_hold', 'released',
                    'out_for_delivery', 'delivered', 'delayed', 're_routed',
                    'exception', 'cancelled',
                ]],
            },
        },
        estimated_departure: { type: DataTypes.DATE },
        actual_departure: { type: DataTypes.DATE },
        estimated_arrival: { type: DataTypes.DATE },
        actual_arrival: { type: DataTypes.DATE },
        gross_weight_kg: { type: DataTypes.DECIMAL(16, 3) },
        volume_cbm: { type: DataTypes.DECIMAL(16, 3) },
        package_count: { type: DataTypes.INTEGER },
        declared_value: { type: DataTypes.DECIMAL(20, 2) },
        currency: { type: DataTypes.TEXT },
        incoterm: { type: DataTypes.TEXT },
        metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        created_by: { type: DataTypes.TEXT },
        updated_by: { type: DataTypes.TEXT },
        deleted_by: { type: DataTypes.TEXT },
    }, {
        schema: 'tradeops',
        tableName: 'shipments',
        underscored: true,
        timestamps: true,
        paranoid: true,
        deletedAt: 'deleted_at',
        version: true,
    });

    Shipment.associate = (db) => {
        Shipment.belongsTo(db.TradeOperation, { as: 'tradeOperation', foreignKey: 'trade_operation_id' });
        Shipment.hasMany(db.ShipmentEvent, { as: 'events', foreignKey: 'shipment_id' });
        Shipment.hasMany(db.ShipmentDocument, { as: 'documents', foreignKey: 'shipment_id' });
        Shipment.hasMany(db.ShipmentStatusHistory, { as: 'statusHistory', foreignKey: 'shipment_id' });
    };

    return Shipment;
};
