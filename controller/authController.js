'use strict';
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { signAccessToken } = require('../utils/jwtserver');
const totp = require('../utils/totp');
const { recordAudit } = require('../utils/audit');
const db = require('../models');
const { sendSuccess } = require('../utils/response');
const { AppError } = require('../utils/errors');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const tokenFor = (user) => signAccessToken(
    { id: user.id, email: user.email, role: user.role, tenantId: user.tenant_id, orgCode: user.org_code || null },
    '24h',
);

const register = async (req, res, next) => {
    try {
        const { email, password, name, role, tenantId } = req.body;
        if (!email || !password) return next(new AppError('BAD_REQUEST', 'email and password are required', 400));
        if (String(password).length < 8) return next(new AppError('BAD_REQUEST', 'password must be at least 8 characters', 400));
        const existing = await db.User.findOne({ where: { email } });
        if (existing) return next(new AppError('CONFLICT', 'Email already registered', 409));
        const password_hash = await bcrypt.hash(password, 10);
        const user = await db.User.create({
            email,
            password_hash,
            full_name: name || '',
            role: ['admin', 'operator', 'client'].includes(role) ? role : 'operator',
            tenant_id: tenantId || 'T-DEMO',
        });
        await recordAudit({ actorId: user.id, action: 'auth.register', resourceType: 'user', resourceId: user.id, tenantId: user.tenant_id, metadata: { email } });
        return sendSuccess(req, res, { accessToken: tokenFor(user), role: user.role, userId: user.id, tenantId: user.tenant_id }, 201);
    } catch (err) { return next(err); }
};

// Consume a one-time backup code (hashed). Returns true if matched + burned.
const consumeBackupCode = async (user, code) => {
    const codes = Array.isArray(user.mfa_backup_codes) ? user.mfa_backup_codes : [];
    const h = sha256(code);
    if (!codes.includes(h)) return false;
    await user.update({ mfa_backup_codes: codes.filter((c) => c !== h) });
    return true;
};

const login = async (req, res, next) => {
    try {
        const { email, password, mfaCode } = req.body;
        if (!email || !password) return next(new AppError('BAD_REQUEST', 'email and password are required', 400));
        const user = await db.User.findOne({ where: { email } });
        if (!user) return next(new AppError('UNAUTHORIZED', 'Invalid credentials', 401));
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) return next(new AppError('UNAUTHORIZED', 'Invalid credentials', 401));
        if (!user.is_active) return next(new AppError('FORBIDDEN', 'Account is deactivated', 403));

        // Step-up: enforce MFA when enabled.
        if (user.mfa_enabled) {
            if (!mfaCode) return next(new AppError('MFA_REQUIRED', 'MFA verification code required', 401));
            const ok = totp.verify(user.mfa_secret, mfaCode) || await consumeBackupCode(user, mfaCode);
            if (!ok) {
                await recordAudit({ actorId: user.id, action: 'auth.mfa_failed', resourceType: 'user', resourceId: user.id, tenantId: user.tenant_id });
                return next(new AppError('UNAUTHORIZED', 'Invalid MFA code', 401));
            }
        }

        await recordAudit({ actorId: user.id, action: 'auth.login', resourceType: 'user', resourceId: user.id, tenantId: user.tenant_id, metadata: { ip: req.ip } });
        return sendSuccess(req, res, { accessToken: tokenFor(user), role: user.role, userId: user.id, tenantId: user.tenant_id, mfaEnabled: user.mfa_enabled });
    } catch (err) { return next(err); }
};

const me = async (req, res, next) => {
    try {
        const user = await db.User.findByPk(req.auth.userId, {
            attributes: { exclude: ['password_hash', 'mfa_secret', 'mfa_backup_codes'] },
        });
        if (!user) return next(new AppError('NOT_FOUND', 'User not found', 404));
        return sendSuccess(req, res, user);
    } catch (err) { return next(err); }
};

// --- MFA (TOTP) -----------------------------------------------------------

// Begin enrollment: issue a secret + otpauth URI (for QR) + one-time backup codes.
const enrollMfa = async (req, res, next) => {
    try {
        const user = await db.User.findByPk(req.auth.userId);
        if (!user) return next(new AppError('NOT_FOUND', 'User not found', 404));
        const secret = totp.generateSecret();
        const backupCodes = totp.generateBackupCodes();
        await user.update({ mfa_secret: secret, mfa_enabled: false, mfa_backup_codes: backupCodes.map(sha256) });
        await recordAudit({ actorId: user.id, action: 'mfa.enroll_started', resourceType: 'user', resourceId: user.id, tenantId: user.tenant_id });
        // backupCodes returned in plaintext ONCE; only hashes are stored.
        return sendSuccess(req, res, { secret, otpauthUri: totp.otpauthURI(secret, user.email), backupCodes });
    } catch (err) { return next(err); }
};

// Confirm enrollment by verifying the first TOTP code → activates MFA.
const verifyMfa = async (req, res, next) => {
    try {
        const { code } = req.body;
        const user = await db.User.findByPk(req.auth.userId);
        if (!user || !user.mfa_secret) return next(new AppError('BAD_REQUEST', 'Begin enrollment first', 400));
        if (!totp.verify(user.mfa_secret, code)) return next(new AppError('UNAUTHORIZED', 'Invalid verification code', 401));
        await user.update({ mfa_enabled: true });
        await recordAudit({ actorId: user.id, action: 'mfa.enabled', resourceType: 'user', resourceId: user.id, tenantId: user.tenant_id });
        return sendSuccess(req, res, { mfaEnabled: true });
    } catch (err) { return next(err); }
};

const disableMfa = async (req, res, next) => {
    try {
        const { code } = req.body;
        const user = await db.User.findByPk(req.auth.userId);
        if (!user) return next(new AppError('NOT_FOUND', 'User not found', 404));
        if (user.mfa_enabled && !totp.verify(user.mfa_secret, code) && !(await consumeBackupCode(user, code))) {
            return next(new AppError('UNAUTHORIZED', 'Invalid code', 401));
        }
        await user.update({ mfa_enabled: false, mfa_secret: null, mfa_backup_codes: [] });
        await recordAudit({ actorId: user.id, action: 'mfa.disabled', resourceType: 'user', resourceId: user.id, tenantId: user.tenant_id });
        return sendSuccess(req, res, { mfaEnabled: false });
    } catch (err) { return next(err); }
};

module.exports = { register, login, me, enrollMfa, verifyMfa, disableMfa };
