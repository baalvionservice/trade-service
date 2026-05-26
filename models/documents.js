'use strict';
module.exports = (sequelize, DataTypes) => {
    const Document = sequelize.define('Document', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        tenant_id: { type: DataTypes.TEXT },
        entity_type: { type: DataTypes.STRING(100) },
        entity_id: { type: DataTypes.TEXT },
        // doc_type/status are plain strings (not ENUMs) so the richer frontend
        // vocabulary (commercial_invoice, vaulted, audited, ...) persists 1:1.
        doc_type: { type: DataTypes.STRING(64) },
        title: { type: DataTypes.STRING(255) },
        file_url: { type: DataTypes.TEXT },
        file_hash: { type: DataTypes.TEXT },
        issuer_org_id: { type: DataTypes.TEXT },
        status: { type: DataTypes.STRING(32), defaultValue: 'draft' },
        // Vault metadata the frontend records-governance view needs.
        classification: { type: DataTypes.STRING(32), defaultValue: 'OPERATIONAL' },
        version: { type: DataTypes.INTEGER, defaultValue: 1 },
        company_id: { type: DataTypes.TEXT },
        uploaded_by: { type: DataTypes.TEXT },
        metadata: { type: DataTypes.JSONB, defaultValue: {} },
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
