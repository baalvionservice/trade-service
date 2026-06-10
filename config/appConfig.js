'use strict';
const dotenv = require('dotenv');
dotenv.config();

const parseList = (v, f = []) => v ? v.split(',').map(s => s.trim()).filter(Boolean) : f;

// Known insecure dev-placeholder values that must never reach production.
const DEV_DEFAULTS = new Set([
    'dev_finance_webhook_secret_change_me_min32',
    'dev_gateway_signing_secret',
    'changeme',
    'secret',
    'change_me',
]);

// Only genuine local development tolerates dev-default secrets. Any other
// environment (production, staging, etc.) must supply real secrets (CR-9).
const ENV = process.env.NODE_ENV || 'development';
const IS_DEV = ENV === 'development' || ENV === 'test';

/**
 * Fail fast in every non-development environment when a critical secret is
 * missing or equals a known dev placeholder. Only local dev/test return the
 * dev default so the service still boots without a populated .env.
 */
function requireSecret(envVar, devDefault, label) {
    const value = process.env[envVar];
    if (!IS_DEV) {
        if (!value || value.trim() === '' || DEV_DEFAULTS.has(value.trim())) {
            console.error(`[appConfig] FATAL: ${label} (${envVar}) is missing or uses a known dev default outside development.`);
            process.exit(1);
        }
        return value.trim();
    }
    return value || devDefault;
}

/**
 * Resolve the island auth mode (CR-10). Outside development the gateway-signed
 * identity is mandatory: 'hybrid'/'legacy' would silently re-open the bearer
 * fallback that bypasses session revocation, org kill-switch and CSRF, so they
 * fail fast. 'strict' and 'rs256_only' are the only accepted non-dev modes.
 */
function resolveIslandAuthMode() {
    const m = (process.env.ISLAND_AUTH_MODE || 'hybrid').toLowerCase();
    if (!IS_DEV && (m === 'hybrid' || m === 'legacy')) {
        console.error(`[appConfig] FATAL: ISLAND_AUTH_MODE='${m}' is not permitted outside development; set it to 'strict'.`);
        process.exit(1);
    }
    return m;
}

module.exports = {
    env: process.env.NODE_ENV || 'development',
    port: Number(process.env.PORT || 3025),
    apiVersion: 'v1',
    corsOrigins: parseList(process.env.CORS_ORIGINS, ['http://localhost:3000']),
    jwt: {
        accessSecret: require('@baalvion/auth-node').requireEnv('JWT_ACCESS_SECRET'),
        // Access-token lifetime. Default 24h for backward compatibility; tighten
        // in production (e.g. 15m) now that rotating refresh tokens exist.
        accessTtl: process.env.JWT_ACCESS_TTL || '24h',
        refreshTtlDays: Number(process.env.JWT_REFRESH_TTL_DAYS || 30),
    },
    db: {
        host: process.env.DB_HOST || 'localhost',
        port: Number(process.env.DB_PORT || 5432),
        name: process.env.DB_NAME || 'baalvion_db',
        user: process.env.DB_USER || 'baalvion',
        password: process.env.DB_PASSWORD || '',
    },
    // CR-10: gateway-signed identity mode. Fails fast outside dev for hybrid/legacy.
    islandAuthMode: resolveIslandAuthMode(),
    // R1 read-path cutover (P1-8): when true, every request is pinned to one DB
    // connection carrying the tenant RLS GUCs so non-transactional reads stay scoped
    // under the non-superuser baalvion_app role. OFF by default — it changes the
    // service to a per-request-transaction model (connection held for the request),
    // which must be load-tested. Enable it ATOMICALLY with DB_USER=baalvion_app.
    rlsReadPath: process.env.RLS_READ_PATH === 'true',
    security: {
        ipRateLimit: Number(process.env.RATE_LIMIT_IP_MAX || 120),
        // Per-account brute-force lockout: after N consecutive failed logins the
        // account is locked for M minutes (counter resets on a successful login).
        loginMaxAttempts: Number(process.env.LOGIN_MAX_ATTEMPTS || 5),
        loginLockoutMinutes: Number(process.env.LOGIN_LOCKOUT_MINUTES || 15),
        // HMAC secret used by the BFF gateway to sign identity headers.
        // Fails fast in production if unset or uses a known dev placeholder.
        gatewaySigningSecret: requireSecret('GATEWAY_SIGNING_SECRET', 'dev_gateway_signing_secret', 'Gateway signing secret'),
    },
    // financial-services-java integration (money/KYC/risk system of record).
    finance: {
        // Shared HMAC-SHA256 secret for the Java→Node finance-events webhook. MUST match the
        // audit-service webhook_subscription secret in financial-services-java (FINANCE_WEBHOOK_SECRET).
        // Fails fast in production if unset or uses the known dev placeholder.
        webhookSecret: requireSecret('FINANCE_WEBHOOK_SECRET', 'dev_finance_webhook_secret_change_me_min32', 'Finance webhook signing secret'),
        // Base URLs for the Java resource servers. The finance facade calls these directly on the
        // trusted internal network (gateway-trusted in dev; RS256 bearer when secured).
        payment:    process.env.SVC_PAYMENT    || 'http://localhost:3015',
        ledger:     process.env.SVC_LEDGER     || 'http://localhost:3014',
        account:    process.env.SVC_ACCOUNT    || 'http://localhost:3016',
        escrow:     process.env.SVC_ESCROW     || 'http://localhost:3017',
        settlement: process.env.SVC_SETTLEMENT || 'http://localhost:3018',
        risk:       process.env.SVC_RISK       || 'http://localhost:3035',
        // Set true once the Java suite is up; gates the facade from hard-failing when it's down.
        enabled:    process.env.FINANCE_ENABLED === 'true',
    },
};
