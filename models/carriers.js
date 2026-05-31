'use strict';
module.exports = (sequelize, DataTypes) => {
    // Logistics carrier registry (shared marketplace — global, not tenant-scoped, like Listing).
    // Carries both the presentation fields the frontend reads and the rate parameters the freight
    // quote engine uses to compute real per-route quotes (controller/freightController.js).
    const Carrier = sequelize.define('Carrier', {
        id: { type: DataTypes.STRING(64), primaryKey: true }, // e.g. 'CARR-MAERSK'
        name: { type: DataTypes.STRING(255), allowNull: false },
        rating: { type: DataTypes.DECIMAL(3, 2), defaultValue: 4.5 },
        regions: { type: DataTypes.JSONB, defaultValue: [] },
        avg_delivery_time: { type: DataTypes.STRING(50) }, // human label, e.g. "21 days"
        starting_price: { type: DataTypes.DECIMAL(20, 2), defaultValue: 0 },
        logo: { type: DataTypes.TEXT },
        description: { type: DataTypes.TEXT },
        specializations: { type: DataTypes.JSONB, defaultValue: [] },
        // Engine inputs:
        modes: { type: DataTypes.JSONB, defaultValue: [] }, // ['sea','air','road','rail']
        base_fee: { type: DataTypes.DECIMAL(20, 2), defaultValue: 0 },
        rate_per_kg: { type: DataTypes.DECIMAL(20, 4), defaultValue: 0 },
        transit_days: { type: DataTypes.INTEGER, defaultValue: 21 },
        reliability: { type: DataTypes.INTEGER, defaultValue: 90 }, // 0-100
        active: { type: DataTypes.BOOLEAN, defaultValue: true },
    }, {
        schema: 'trade',
        tableName: 'carriers',
        underscored: true,
        timestamps: true,
    });

    return Carrier;
};
