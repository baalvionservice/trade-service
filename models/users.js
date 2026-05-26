'use strict';
module.exports = (sequelize, DataTypes) => {
    const User = sequelize.define('User', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        email: { type: DataTypes.STRING(255), allowNull: false, unique: true },
        password_hash: { type: DataTypes.TEXT, allowNull: false },
        full_name: { type: DataTypes.STRING(255), defaultValue: '' },
        role: {
            type: DataTypes.ENUM('admin', 'operator', 'client'),
            defaultValue: 'operator',
        },
        tenant_id: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'T-DEMO' },
        org_code: { type: DataTypes.STRING(64) }, // participant org for dual-party trade access
        mfa_enabled: { type: DataTypes.BOOLEAN, defaultValue: false },
        mfa_secret: { type: DataTypes.TEXT },                          // base32 TOTP secret
        mfa_backup_codes: { type: DataTypes.JSONB, defaultValue: [] }, // sha256 hashes
        is_active: { type: DataTypes.BOOLEAN, defaultValue: true },
    }, {
        schema: 'trade',
        tableName: 'users',
        underscored: true,
        timestamps: true,
    });
    return User;
};
