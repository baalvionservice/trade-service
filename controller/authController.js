'use strict';
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { signAccessToken } = require('../utils/jwtserver');
const totp = require('../utils/totp');
const { recordAudit } = require('../utils/audit');
const db = require('../models');
const config = require('../config/appConfig');
const sessions = require('../services/sessionService');
const { sendSuccess } = require('../utils/response');
const { AppError } = require('../utils/errors');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const tokenFor = (user) => signAccessToken(
    { id: user.id, email: user.email, role: user.role, tenantId: user.tenant_id, orgCode: user.org_code || null },
    config.jwt.accessTtl,
);

const REFRESH_COOKIE = 'refresh_token';
const setRefreshCookie = (res, token) => res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: config.env === 'production',
    sameSite: 'lax',
    maxAge: sessions.REFRESH_TTL_MS,
    path: '/',
});
const clearRefreshCookie = (res) => res.clearCookie(REFRESH_COOKIE, { path: '/' });
const presentedRefreshToken = (req) => (req.cookies && req.cookies[REFRESH_COOKIE]) || req.body?.refreshToken || null;

// Issue an access token + a rotating refresh-token session, set the httpOnly
// cookie, and shape the auth success payload.
const issueAuthResult = async (req, res, user, status = 200, extra = {}) => {
    const { token: refreshToken } = await sessions.issueSession({
        userId: user.id,
        tenantId: user.tenant_id,
        userAgent: req.headers['user-agent'],
        ip: req.ip,
    });
    setRefreshCookie(res, refreshToken);
    return sendSuccess(req, res, {
        accessToken: tokenFor(user),
        refreshToken,
        role: user.role,
        userId: user.id,
        tenantId: user.tenant_id,
        ...extra,
    }, status);
};

const serializeSession = (row, currentId) => ({
    id: row.id,
    current: row.id === currentId,
    userAgent: row.user_agent || null,
    ip: row.ip || null,
    createdAt: row.createdAt, // Sequelize timestamp attribute is camelCase
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
});

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
        return issueAuthResult(req, res, user, 201);
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

// --- Brute-force lockout ---------------------------------------------------

const lockoutError = (lockedUntil) => {
    const retryAfterSeconds = Math.max(1, Math.ceil((new Date(lockedUntil).getTime() - Date.now()) / 1000));
    return new AppError('ACCOUNT_LOCKED', 'Account temporarily locked due to repeated failed logins', 423, { retryAfterSeconds });
};

// Record a failed attempt; lock the account once the threshold is reached.
// (Account-scoped, so it survives an attacker rotating source IPs; the IP rate
// limiter guards the orthogonal case. A correct login resets the counter.)
const registerFailedLogin = async (user, req) => {
    const max = config.security.loginMaxAttempts;
    const attempts = (user.failed_login_attempts || 0) + 1;
    if (attempts >= max) {
        const lockedUntil = new Date(Date.now() + config.security.loginLockoutMinutes * 60 * 1000);
        await user.update({ failed_login_attempts: 0, locked_until: lockedUntil });
        await recordAudit({ actorId: user.id, action: 'auth.account_locked', resourceType: 'user', resourceId: user.id, tenantId: user.tenant_id, metadata: { ip: req.ip, threshold: max, lockedUntil } });
        return { locked: true, lockedUntil };
    }
    await user.update({ failed_login_attempts: attempts });
    return { locked: false, remaining: max - attempts };
};

const login = async (req, res, next) => {
    try {
        const { email, password, mfaCode } = req.body;
        if (!email || !password) return next(new AppError('BAD_REQUEST', 'email and password are required', 400));
        const user = await db.User.findOne({ where: { email } });
        if (!user) return next(new AppError('UNAUTHORIZED', 'Invalid credentials', 401));

        // Reject locked accounts before spending a bcrypt comparison.
        if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
            await recordAudit({ actorId: user.id, action: 'auth.login_blocked_locked', resourceType: 'user', resourceId: user.id, tenantId: user.tenant_id, metadata: { ip: req.ip } });
            return next(lockoutError(user.locked_until));
        }

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            const r = await registerFailedLogin(user, req);
            return next(r.locked ? lockoutError(r.lockedUntil) : new AppError('UNAUTHORIZED', 'Invalid credentials', 401));
        }
        if (!user.is_active) return next(new AppError('FORBIDDEN', 'Account is deactivated', 403));

        // Step-up: enforce MFA when enabled (a wrong code is also a failed attempt).
        if (user.mfa_enabled) {
            if (!mfaCode) return next(new AppError('MFA_REQUIRED', 'MFA verification code required', 401));
            const ok = totp.verify(user.mfa_secret, mfaCode) || await consumeBackupCode(user, mfaCode);
            if (!ok) {
                await recordAudit({ actorId: user.id, action: 'auth.mfa_failed', resourceType: 'user', resourceId: user.id, tenantId: user.tenant_id });
                const r = await registerFailedLogin(user, req);
                return next(r.locked ? lockoutError(r.lockedUntil) : new AppError('UNAUTHORIZED', 'Invalid MFA code', 401));
            }
        }

        // Success → reset the failure counter and stamp the login time.
        await user.update({ failed_login_attempts: 0, locked_until: null, last_login_at: new Date() });
        await recordAudit({ actorId: user.id, action: 'auth.login', resourceType: 'user', resourceId: user.id, tenantId: user.tenant_id, metadata: { ip: req.ip } });
        return issueAuthResult(req, res, user, 200, { mfaEnabled: user.mfa_enabled });
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

// --- Refresh-token sessions ----------------------------------------------

// Rotate a refresh token: validates + single-uses the presented token, issues a
// fresh access+refresh pair. Replaying a spent token revokes the whole family.
const refresh = async (req, res, next) => {
    try {
        const token = presentedRefreshToken(req);
        if (!token) return next(new AppError('UNAUTHORIZED', 'No refresh token provided', 401));
        const result = await sessions.rotateSession({ token, userAgent: req.headers['user-agent'], ip: req.ip });

        if (result.reuseDetected) {
            await recordAudit({ actorId: result.userId, action: 'auth.refresh_reuse_detected', resourceType: 'session', resourceId: result.familyId, metadata: { ip: req.ip } });
            clearRefreshCookie(res);
            return next(new AppError('UNAUTHORIZED', 'Refresh token reuse detected — all sessions revoked', 401));
        }

        const user = await db.User.findByPk(result.userId);
        if (!user || !user.is_active) {
            clearRefreshCookie(res);
            return next(new AppError('UNAUTHORIZED', 'Account unavailable', 401));
        }
        await recordAudit({ actorId: user.id, action: 'auth.refresh', resourceType: 'session', resourceId: result.row.id, tenantId: user.tenant_id });
        setRefreshCookie(res, result.token);
        return sendSuccess(req, res, {
            accessToken: tokenFor(user),
            refreshToken: result.token,
            role: user.role,
            userId: user.id,
            tenantId: user.tenant_id,
        });
    } catch (err) { return next(err); }
};

// Logout: revoke the presented session and clear the cookie. Idempotent.
const logout = async (req, res, next) => {
    try {
        const token = presentedRefreshToken(req);
        if (token) await sessions.revokeByToken(token);
        clearRefreshCookie(res);
        if (req.auth?.userId) {
            await recordAudit({ actorId: req.auth.userId, action: 'auth.logout', resourceType: 'session', resourceId: req.auth.userId, tenantId: req.auth.tenantId });
        }
        return sendSuccess(req, res, { loggedOut: true });
    } catch (err) { return next(err); }
};

// List the caller's active sessions (device/session management UI).
const listSessions = async (req, res, next) => {
    try {
        const parsed = presentedRefreshToken(req);
        const currentId = parsed ? String(parsed).split('.')[0] : null;
        const rows = await sessions.listActive(req.auth.userId);
        return sendSuccess(req, res, rows.map((r) => serializeSession(r, currentId)));
    } catch (err) { return next(err); }
};

// Revoke a specific session by id (must belong to the caller).
const revokeSession = async (req, res, next) => {
    try {
        const ok = await sessions.revokeById(req.params.id, req.auth.userId);
        if (!ok) return next(new AppError('NOT_FOUND', 'Session not found', 404));
        await recordAudit({ actorId: req.auth.userId, action: 'auth.session_revoked', resourceType: 'session', resourceId: req.params.id, tenantId: req.auth.tenantId });
        return sendSuccess(req, res, { revoked: true });
    } catch (err) { return next(err); }
};

// Revoke every session for the caller ("sign out everywhere").
const revokeAllSessions = async (req, res, next) => {
    try {
        const count = await sessions.revokeAllForUser(req.auth.userId);
        clearRefreshCookie(res);
        await recordAudit({ actorId: req.auth.userId, action: 'auth.session_revoked_all', resourceType: 'session', resourceId: req.auth.userId, tenantId: req.auth.tenantId, metadata: { count } });
        return sendSuccess(req, res, { revoked: count });
    } catch (err) { return next(err); }
};

module.exports = {
    register, login, me, enrollMfa, verifyMfa, disableMfa,
    refresh, logout, listSessions, revokeSession, revokeAllSessions,
};
