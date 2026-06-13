'use strict';
// Trade Operations Cloud (War Room 4) — parent aggregate. Schema `tradeops`,
// UUID PK, tenant-scoped (RLS + index.js hooks), soft-deleted (paranoid),
// optimistic-locked (version). See migrations/009_tradeops_foundation.sql.
module.exports = (sequelize, DataTypes) => {
    const TradeOperation = sequelize.define('TradeOperation', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        tenant_id: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'T-DEMO' },
        reference_no: { type: DataTypes.TEXT, allowNull: false },
        order_id: { type: DataTypes.UUID },
        buyer_org_id: { type: DataTypes.TEXT },
        seller_org_id: { type: DataTypes.TEXT },
        commodity: { type: DataTypes.TEXT },
        hs_code: { type: DataTypes.TEXT },
        incoterm: { type: DataTypes.TEXT },
        origin_country: { type: DataTypes.TEXT },
        destination_country: { type: DataTypes.TEXT },
        status: {
            type: DataTypes.TEXT,
            allowNull: false,
            defaultValue: 'draft',
            validate: { isIn: [['draft', 'active', 'in_transit', 'on_hold', 'completed', 'cancelled']] },
        },
        priority: {
            type: DataTypes.TEXT,
            allowNull: false,
            defaultValue: 'normal',
            validate: { isIn: [['low', 'normal', 'high', 'critical']] },
        },
        total_value: { type: DataTypes.DECIMAL(20, 2) },
        currency: { type: DataTypes.TEXT },
        expected_start_date: { type: DataTypes.DATEONLY },
        expected_completion_date: { type: DataTypes.DATEONLY },
        metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        created_by: { type: DataTypes.TEXT },
        updated_by: { type: DataTypes.TEXT },
        deleted_by: { type: DataTypes.TEXT },
    }, {
        schema: 'tradeops',
        tableName: 'trade_operations',
        underscored: true,
        timestamps: true,
        paranoid: true,
        deletedAt: 'deleted_at',
        version: true,
    });

    TradeOperation.associate = (db) => {
        TradeOperation.hasMany(db.TradeShipment, { as: 'shipments', foreignKey: 'trade_operation_id' });
        TradeOperation.hasMany(db.ShipmentDocument, { as: 'documents', foreignKey: 'trade_operation_id' });
    };

    return TradeOperation;
};
