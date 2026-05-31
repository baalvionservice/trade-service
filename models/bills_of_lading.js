'use strict';
module.exports = (sequelize, DataTypes) => {
    // Electronic Bill of Lading (Logistics #3) — a document of title for goods in transit, with a
    // negotiable-instrument lifecycle (issue → endorse/transfer → surrender → release). Tenant-scoped.
    const BillOfLading = sequelize.define('BillOfLading', {
        id: { type: DataTypes.STRING(64), primaryKey: true }, // 'BL-...'
        tenant_id: { type: DataTypes.TEXT },
        shipment_id: { type: DataTypes.TEXT },
        order_id: { type: DataTypes.TEXT },
        bl_number: { type: DataTypes.STRING(80), unique: true },
        bl_type: {
            // negotiable = "to order" (transferable title); straight = named consignee (non-transferable);
            // seaway = non-negotiable receipt.
            type: DataTypes.ENUM('negotiable', 'straight', 'seaway'),
            defaultValue: 'negotiable',
        },
        shipper: { type: DataTypes.JSONB, defaultValue: {} },
        consignee: { type: DataTypes.JSONB, defaultValue: {} },
        notify_party: { type: DataTypes.JSONB, defaultValue: {} },
        carrier_id: { type: DataTypes.STRING(64) },
        carrier_name: { type: DataTypes.STRING(255) },
        vessel_name: { type: DataTypes.STRING(255) },
        voyage_number: { type: DataTypes.STRING(80) },
        port_of_loading: { type: DataTypes.STRING(255) },
        port_of_discharge: { type: DataTypes.STRING(255) },
        place_of_receipt: { type: DataTypes.STRING(255) },
        place_of_delivery: { type: DataTypes.STRING(255) },
        goods_description: { type: DataTypes.TEXT },
        packages: { type: DataTypes.INTEGER },
        gross_weight: { type: DataTypes.DECIMAL(20, 3) },
        measurement: { type: DataTypes.STRING(80) },
        freight_terms: { type: DataTypes.ENUM('prepaid', 'collect'), defaultValue: 'prepaid' },
        status: {
            type: DataTypes.ENUM('draft', 'issued', 'transferred', 'surrendered', 'released', 'cancelled'),
            defaultValue: 'draft',
        },
        current_holder: { type: DataTypes.STRING(160) }, // who holds title now
        holder_history: { type: DataTypes.JSONB, defaultValue: [] }, // endorsement chain
        signatures: { type: DataTypes.JSONB, defaultValue: [] },
        issued_at: { type: DataTypes.DATE },
        surrendered_at: { type: DataTypes.DATE },
        released_at: { type: DataTypes.DATE },
        metadata: { type: DataTypes.JSONB, defaultValue: {} },
    }, {
        schema: 'trade',
        tableName: 'bills_of_lading',
        underscored: true,
        timestamps: true,
    });

    return BillOfLading;
};
