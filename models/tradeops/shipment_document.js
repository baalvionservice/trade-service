'use strict';
// Trade Operations Cloud — trade document bound to a shipment (and optionally the
// parent operation). storage_ref points at the object store / CMS media; sha256
// gives tamper-evidence. Schema `tradeops`, paranoid, versioned.
module.exports = (sequelize, DataTypes) => {
    const ShipmentDocument = sequelize.define('ShipmentDocument', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        tenant_id: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'T-DEMO' },
        shipment_id: { type: DataTypes.UUID, allowNull: false },
        trade_operation_id: { type: DataTypes.UUID },
        doc_type: { type: DataTypes.TEXT, allowNull: false },
        title: { type: DataTypes.TEXT },
        file_name: { type: DataTypes.TEXT },
        mime_type: { type: DataTypes.TEXT },
        file_size_bytes: { type: DataTypes.BIGINT },
        storage_provider: { type: DataTypes.TEXT },
        storage_ref: { type: DataTypes.TEXT },
        sha256: { type: DataTypes.TEXT },
        status: {
            type: DataTypes.TEXT,
            allowNull: false,
            defaultValue: 'pending',
            validate: { isIn: [['pending', 'verified', 'rejected', 'expired']] },
        },
        issued_at: { type: DataTypes.DATE },
        expires_at: { type: DataTypes.DATE },
        metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        created_by: { type: DataTypes.TEXT },
        updated_by: { type: DataTypes.TEXT },
        deleted_by: { type: DataTypes.TEXT },
    }, {
        schema: 'tradeops',
        tableName: 'shipment_documents',
        underscored: true,
        timestamps: true,
        paranoid: true,
        deletedAt: 'deleted_at',
        version: true,
    });

    ShipmentDocument.associate = (db) => {
        ShipmentDocument.belongsTo(db.TradeShipment, { as: 'shipment', foreignKey: 'shipment_id' });
        ShipmentDocument.belongsTo(db.TradeOperation, { as: 'tradeOperation', foreignKey: 'trade_operation_id' });
    };

    return ShipmentDocument;
};
