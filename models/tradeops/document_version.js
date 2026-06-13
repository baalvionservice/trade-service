'use strict';
// Document Management System — an immutable file version (War Room 4, Prompt 4).
// Each upload of a document produces a new, append-only version row pointing at one
// stored object. The row carries everything needed to fetch, decrypt, integrity-check
// and report on that object: storage coordinates, the plaintext SHA-256, the
// envelope-encryption parameters, the virus-scan verdict, and extracted metadata.
// Schema `tradeops`, UUID PK. Versions are never updated except for scan results.
module.exports = (sequelize, DataTypes) => {
    const DocumentVersion = sequelize.define('DocumentVersion', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        tenant_id: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'T-DEMO' },
        document_id: { type: DataTypes.UUID, allowNull: false },
        version_no: { type: DataTypes.INTEGER, allowNull: false },

        // File identity.
        file_name: { type: DataTypes.TEXT, allowNull: false },
        original_file_name: { type: DataTypes.TEXT },
        mime_type: { type: DataTypes.TEXT, allowNull: false },
        detected_mime_type: { type: DataTypes.TEXT },
        file_size_bytes: { type: DataTypes.BIGINT, allowNull: false },
        // SHA-256 of the PLAINTEXT bytes — tamper-evidence, independent of encryption.
        sha256: { type: DataTypes.TEXT, allowNull: false },

        // Storage coordinates.
        storage_provider: { type: DataTypes.TEXT, allowNull: false },
        storage_bucket: { type: DataTypes.TEXT },
        storage_key: { type: DataTypes.TEXT, allowNull: false },

        // App-level envelope encryption (lib/encryption.js). 'none' = stored plaintext.
        encryption_algo: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'none' },
        encryption_key_id: { type: DataTypes.TEXT }, // non-secret key fingerprint
        encryption_iv: { type: DataTypes.TEXT },     // base64 nonce
        encryption_tag: { type: DataTypes.TEXT },    // base64 GCM auth tag

        // Virus scan lifecycle.
        scan_status: {
            type: DataTypes.TEXT,
            allowNull: false,
            defaultValue: 'pending',
            validate: { isIn: [['pending', 'clean', 'infected', 'error', 'skipped']] },
        },
        scan_engine: { type: DataTypes.TEXT },
        scan_signature: { type: DataTypes.TEXT },
        scan_result: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        scanned_at: { type: DataTypes.DATE },

        extracted_metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        uploaded_by: { type: DataTypes.TEXT },
    }, {
        schema: 'tradeops',
        tableName: 'document_versions',
        underscored: true,
        timestamps: true,
        updatedAt: false, // versions are append-only; scan fields are the only mutation
    });

    DocumentVersion.associate = (db) => {
        DocumentVersion.belongsTo(db.TradeDocument, { as: 'document', foreignKey: 'document_id' });
    };

    return DocumentVersion;
};
