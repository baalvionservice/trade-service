'use strict';
module.exports = (sequelize, DataTypes) => {
    const Dispute = sequelize.define('Dispute', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        tenant_id: { type: DataTypes.TEXT },
        order_id: { type: DataTypes.INTEGER },
        claimant_org_id: { type: DataTypes.TEXT },
        respondent_org_id: { type: DataTypes.TEXT },
        dispute_type: {
            type: DataTypes.ENUM('quality', 'delivery', 'payment', 'documentation', 'other'),
            defaultValue: 'other',
        },
        description: { type: DataTypes.TEXT },
        status: {
            type: DataTypes.ENUM('open', 'evidence_collection', 'mediation', 'arbitration', 'resolved', 'closed'),
            defaultValue: 'open',
        },
        resolution: { type: DataTypes.TEXT },
        resolved_at: { type: DataTypes.DATE },
        evidence: { type: DataTypes.JSONB, defaultValue: [] },
    }, {
        schema: 'trade',
        tableName: 'disputes',
        underscored: true,
        timestamps: true,
    });

    return Dispute;
};
