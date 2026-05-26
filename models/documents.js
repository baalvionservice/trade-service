'use strict';
module.exports = (sequelize, DataTypes) => {
    const Document = sequelize.define('Document', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        tenant_id: { type: DataTypes.TEXT },
        entity_type: { type: DataTypes.STRING(100) },
        entity_id: { type: DataTypes.TEXT },
        doc_type: {
            type: DataTypes.ENUM(
                'invoice', 'bill_of_lading', 'certificate_of_origin',
                'packing_list', 'letter_of_credit', 'inspection_report',
                'customs_declaration', 'insurance_certificate', 'other'
            ),
        },
        title: { type: DataTypes.STRING(255) },
        file_url: { type: DataTypes.TEXT },
        file_hash: { type: DataTypes.TEXT },
        issuer_org_id: { type: DataTypes.TEXT },
        status: {
            type: DataTypes.ENUM('draft', 'issued', 'verified', 'rejected', 'expired'),
            defaultValue: 'draft',
        },
        issued_at: { type: DataTypes.DATE },
        expires_at: { type: DataTypes.DATE },
    }, {
        schema: 'trade',
        tableName: 'documents',
        underscored: true,
        timestamps: true,
    });

    return Document;
};
