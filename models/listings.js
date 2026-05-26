'use strict';
module.exports = (sequelize, DataTypes) => {
    // camelCase attributes + underscored:false so the JSON payload maps 1:1 to the
    // frontend MarketplaceListing type with no adapter layer.
    const Listing = sequelize.define('Listing', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        tenantId: { type: DataTypes.STRING, allowNull: false, defaultValue: 'T-DEMO' },
        companyId: { type: DataTypes.STRING, allowNull: false, defaultValue: 'COMP-101' },
        companyName: { type: DataTypes.STRING, defaultValue: 'Institutional Partner' },
        type: { type: DataTypes.ENUM('offer', 'request'), defaultValue: 'offer' },
        title: { type: DataTypes.STRING(255), allowNull: false },
        description: { type: DataTypes.TEXT },
        category: { type: DataTypes.STRING(120) },
        trustScore: { type: DataTypes.INTEGER, defaultValue: 750 },
        isVerified: { type: DataTypes.BOOLEAN, defaultValue: true },
        hsCode: { type: DataTypes.STRING(32) },
        originCountry: { type: DataTypes.STRING(120) },
        unit: { type: DataTypes.STRING(40), defaultValue: 'unit' },
        currency: { type: DataTypes.STRING(8), defaultValue: 'USD' },
        basePrice: { type: DataTypes.FLOAT },
        marketAveragePrice: { type: DataTypes.FLOAT },
        moq: { type: DataTypes.INTEGER },
        leadTime: { type: DataTypes.STRING(60) },
        sellerTier: { type: DataTypes.STRING(40), defaultValue: 'Verified' },
        incoterms: { type: DataTypes.JSONB, defaultValue: [] },
        paymentTerms: { type: DataTypes.JSONB, defaultValue: [] },
        certifications: { type: DataTypes.JSONB, defaultValue: [] },
        pricingTiers: { type: DataTypes.JSONB, defaultValue: [] },
        status: { type: DataTypes.ENUM('active', 'draft', 'archived'), defaultValue: 'active' },
    }, {
        schema: 'trade',
        tableName: 'marketplace_listings',
        underscored: false,
        timestamps: true,
    });

    return Listing;
};
