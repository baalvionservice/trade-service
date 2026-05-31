'use strict';
module.exports = (sequelize, DataTypes) => {
    // Certificate of Origin (Logistics #5) — attests the country of origin of goods for tariff /
    // trade-agreement purposes. Issued by exporter, e-stamped, then certified by a chamber. Tenant-scoped.
    const CertificateOfOrigin = sequelize.define('CertificateOfOrigin', {
        id: { type: DataTypes.STRING(64), primaryKey: true }, // 'COO-...'
        tenant_id: { type: DataTypes.TEXT },
        shipment_id: { type: DataTypes.TEXT },
        order_id: { type: DataTypes.TEXT },
        customs_entry_id: { type: DataTypes.TEXT },
        certificate_number: { type: DataTypes.STRING(80), unique: true },
        coo_type: { type: DataTypes.ENUM('non_preferential', 'preferential'), defaultValue: 'non_preferential' },
        agreement: { type: DataTypes.STRING(80) }, // e.g. GSP, EUR.1, USMCA, India-ASEAN FTA (preferential)
        exporter: { type: DataTypes.JSONB, defaultValue: {} },
        consignee: { type: DataTypes.JSONB, defaultValue: {} },
        producer: { type: DataTypes.JSONB, defaultValue: {} },
        origin_country: { type: DataTypes.STRING(80) },
        destination_country: { type: DataTypes.STRING(80) },
        goods: { type: DataTypes.JSONB, defaultValue: [] }, // [{ description, hsCode, quantity, originCriterion }]
        origin_criterion: { type: DataTypes.STRING(40), defaultValue: 'WO' }, // WO | PSR | RVC
        transport_details: { type: DataTypes.STRING(255) },
        status: { type: DataTypes.ENUM('draft', 'issued', 'submitted', 'certified', 'rejected'), defaultValue: 'draft' },
        chamber: { type: DataTypes.STRING(160) },
        e_stamp: { type: DataTypes.JSONB, defaultValue: null },
        certifier_stamp: { type: DataTypes.JSONB, defaultValue: null },
        issued_at: { type: DataTypes.DATE },
        certified_at: { type: DataTypes.DATE },
        metadata: { type: DataTypes.JSONB, defaultValue: {} },
    }, {
        schema: 'trade',
        tableName: 'certificates_of_origin',
        underscored: true,
        timestamps: true,
    });

    return CertificateOfOrigin;
};
