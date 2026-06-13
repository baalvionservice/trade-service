'use strict';
// Document Management System — canonical logical document (War Room 4, Prompt 4).
// One row per logical trade document; its file content lives in one-or-more
// immutable tradeops.document_versions. Schema `tradeops`, UUID PK, paranoid,
// optimistically locked (version:true). Optionally bound to a shipment and/or
// trade operation — that binding is the "document linking to shipments" feature.
module.exports = (sequelize, DataTypes) => {
    const TradeDocument = sequelize.define('TradeDocument', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        tenant_id: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'T-DEMO' },
        doc_type: {
            type: DataTypes.TEXT,
            allowNull: false,
            validate: { isIn: [['commercial_invoice', 'packing_list', 'bill_of_lading', 'certificate_of_origin', 'insurance_document', 'other']] },
        },
        title: { type: DataTypes.TEXT },
        description: { type: DataTypes.TEXT },
        status: {
            type: DataTypes.TEXT,
            allowNull: false,
            defaultValue: 'draft',
            // draft → scanning (version uploaded) → available | quarantined,
            // then verified/rejected/archived/expired as operational outcomes.
            validate: { isIn: [['draft', 'scanning', 'available', 'quarantined', 'rejected', 'verified', 'archived', 'expired']] },
        },
        classification: {
            type: DataTypes.TEXT,
            allowNull: false,
            defaultValue: 'OPERATIONAL',
            validate: { isIn: [['PUBLIC', 'OPERATIONAL', 'CONFIDENTIAL', 'RESTRICTED']] },
        },
        // Linkage — both nullable so a document can exist at the operation level or
        // be attached to a specific shipment later.
        shipment_id: { type: DataTypes.UUID },
        trade_operation_id: { type: DataTypes.UUID },
        current_version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        latest_version_id: { type: DataTypes.UUID },
        issued_at: { type: DataTypes.DATE },
        expires_at: { type: DataTypes.DATE },
        metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        created_by: { type: DataTypes.TEXT },
        updated_by: { type: DataTypes.TEXT },
        deleted_by: { type: DataTypes.TEXT },
    }, {
        schema: 'tradeops',
        tableName: 'documents',
        underscored: true,
        timestamps: true,
        paranoid: true,
        deletedAt: 'deleted_at',
        version: true,
    });

    TradeDocument.associate = (db) => {
        TradeDocument.hasMany(db.DocumentVersion, { as: 'versions', foreignKey: 'document_id' });
        TradeDocument.hasMany(db.DocumentEvent, { as: 'events', foreignKey: 'document_id' });
        TradeDocument.belongsTo(db.DocumentVersion, { as: 'latestVersion', foreignKey: 'latest_version_id', constraints: false });
        TradeDocument.belongsTo(db.TradeShipment, { as: 'shipment', foreignKey: 'shipment_id', constraints: false });
        TradeDocument.belongsTo(db.TradeOperation, { as: 'tradeOperation', foreignKey: 'trade_operation_id', constraints: false });
    };

    return TradeDocument;
};
