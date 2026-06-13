'use strict';
// Trade Operations Cloud — append-only shipment status-transition ledger.
// Immutable: only created_at is tracked (no updated_at / soft delete / version).
module.exports = (sequelize, DataTypes) => {
    const ShipmentStatusHistory = sequelize.define('ShipmentStatusHistory', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        tenant_id: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'T-DEMO' },
        shipment_id: { type: DataTypes.UUID, allowNull: false },
        from_status: { type: DataTypes.TEXT },
        to_status: { type: DataTypes.TEXT, allowNull: false },
        reason: { type: DataTypes.TEXT },
        note: { type: DataTypes.TEXT },
        changed_by: { type: DataTypes.TEXT },
        changed_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    }, {
        schema: 'tradeops',
        tableName: 'shipment_status_history',
        underscored: true,
        timestamps: false, // append-only; created_at managed explicitly
    });

    ShipmentStatusHistory.associate = (db) => {
        ShipmentStatusHistory.belongsTo(db.TradeShipment, { as: 'shipment', foreignKey: 'shipment_id' });
    };

    return ShipmentStatusHistory;
};
