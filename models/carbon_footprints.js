'use strict';
module.exports = (sequelize, DataTypes) => {
    // Per-shipment carbon footprint estimate + voluntary offset state (Logistics #6, P2). Tenant-scoped.
    const CarbonFootprint = sequelize.define('CarbonFootprint', {
        id: { type: DataTypes.STRING(64), primaryKey: true }, // 'CF-...'
        tenant_id: { type: DataTypes.TEXT },
        shipment_id: { type: DataTypes.TEXT },
        order_id: { type: DataTypes.TEXT },
        mode: { type: DataTypes.STRING(20) },
        distance_km: { type: DataTypes.DECIMAL(20, 2) },
        weight_kg: { type: DataTypes.DECIMAL(20, 2) },
        weight_tonnes: { type: DataTypes.DECIMAL(20, 4) },
        emission_factor: { type: DataTypes.DECIMAL(10, 2) },
        co2_kg: { type: DataTypes.DECIMAL(20, 2) },
        co2_tonnes: { type: DataTypes.DECIMAL(20, 4) },
        offset_cost_usd: { type: DataTypes.DECIMAL(20, 2) },
        offset_status: { type: DataTypes.ENUM('none', 'pending', 'purchased'), defaultValue: 'none' },
        offset_provider: { type: DataTypes.STRING(120) },
        offset_reference: { type: DataTypes.STRING(120) },
        offset_purchased_at: { type: DataTypes.DATE },
        methodology: { type: DataTypes.STRING(160) },
        metadata: { type: DataTypes.JSONB, defaultValue: {} },
    }, {
        schema: 'trade',
        tableName: 'carbon_footprints',
        underscored: true,
        timestamps: true,
    });

    return CarbonFootprint;
};
