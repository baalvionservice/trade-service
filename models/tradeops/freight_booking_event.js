'use strict';
// Freight Marketplace Integration Layer (Prompt 10) — append-only booking audit.
// One immutable row per quote / booking attempt / carrier fallback / lifecycle
// transition behind a freight booking. Schema `tradeops`, tenant-scoped (RLS +
// index.js hooks). See migration 016 + service/freight/freightGateway.js.
module.exports = (sequelize, DataTypes) => {
    const FreightBookingEvent = sequelize.define('FreightBookingEvent', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        tenant_id: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'T-DEMO' },
        booking_id: { type: DataTypes.UUID, allowNull: false },
        carrier: { type: DataTypes.TEXT },
        event_type: { type: DataTypes.TEXT, allowNull: false }, // quoted/attempt/fallback/booked/failed/<status>/retry/recovered/cancelled
        status: { type: DataTypes.TEXT },
        attempt: { type: DataTypes.INTEGER },
        message: { type: DataTypes.TEXT },
        detail: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        created_by: { type: DataTypes.TEXT },
    }, {
        schema: 'tradeops',
        tableName: 'freight_booking_events',
        underscored: true,
        timestamps: true,
        updatedAt: false, // append-only
    });

    FreightBookingEvent.associate = (db) => {
        if (db.FreightBooking) {
            FreightBookingEvent.belongsTo(db.FreightBooking, { as: 'booking', foreignKey: 'booking_id' });
        }
    };

    return FreightBookingEvent;
};
