'use strict';
module.exports = (sequelize, DataTypes) => {
    // Customs declaration/entry (Logistics #4). status is a STRING (not strict ENUM) so the frontend's
    // richer vocab (PENDING/UNDER_REVIEW/CLEARED/CUSTOMS_HOLD/...) round-trips 1:1. Tenant-scoped.
    const CustomsEntry = sequelize.define('CustomsEntry', {
        id: { type: DataTypes.STRING(64), primaryKey: true }, // 'CE-...'
        tenant_id: { type: DataTypes.TEXT },
        shipment_id: { type: DataTypes.TEXT },
        order_id: { type: DataTypes.TEXT },
        origin_country: { type: DataTypes.STRING(80) },
        destination_country: { type: DataTypes.STRING(80) }, // import jurisdiction (US/EU/IN/CN/GB)
        entry_type: { type: DataTypes.STRING(20), defaultValue: 'import' },
        declarant: { type: DataTypes.JSONB, defaultValue: {} },
        importer: { type: DataTypes.JSONB, defaultValue: {} },
        exporter: { type: DataTypes.JSONB, defaultValue: {} },
        incoterm: { type: DataTypes.STRING(10) },
        currency: { type: DataTypes.STRING(10), defaultValue: 'USD' },
        customs_value: { type: DataTypes.DECIMAL(20, 2), defaultValue: 0 },
        line_items: { type: DataTypes.JSONB, defaultValue: [] },
        total_duty: { type: DataTypes.DECIMAL(20, 2), defaultValue: 0 },
        total_tax: { type: DataTypes.DECIMAL(20, 2), defaultValue: 0 },
        total_payable: { type: DataTypes.DECIMAL(20, 2), defaultValue: 0 },
        status: { type: DataTypes.STRING(40), defaultValue: 'draft' },
        template: { type: DataTypes.STRING(40) },
        filing_reference: { type: DataTypes.STRING(80) },
        authorized_by: { type: DataTypes.STRING(120) },
        inspection_notes: { type: DataTypes.TEXT },
        submitted_at: { type: DataTypes.DATE },
        cleared_at: { type: DataTypes.DATE },
        metadata: { type: DataTypes.JSONB, defaultValue: {} },
    }, {
        schema: 'trade',
        tableName: 'customs_entries',
        underscored: true,
        timestamps: true,
    });

    return CustomsEntry;
};
