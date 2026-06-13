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
    // Document Management System — production file engine (War Room 4, Prompt 4).
    // Secure upload → S3-compatible storage → versioning → virus scan → encryption.
    documents: {
        // Object storage driver: 'local' (filesystem, dev default) | 's3' (AWS S3 /
        // MinIO / R2 / any S3-compatible endpoint). The S3 SDK is lazy-required so the
        // service boots without @aws-sdk installed when running the local driver.
        storageProvider: (process.env.DOC_STORAGE_PROVIDER || 'local').toLowerCase(),
        // Local driver root (dev). Files are written under <root>/<storage_key>.
        localDir: process.env.DOC_STORAGE_LOCAL_DIR || require('path').join(__dirname, '..', '.storage', 'documents'),
        // S3-compatible driver settings.
        s3: {
            bucket: process.env.DOC_S3_BUCKET || 'baalvion-trade-documents',
            region: process.env.DOC_S3_REGION || process.env.AWS_REGION || 'us-east-1',
            // Custom endpoint for MinIO / Cloudflare R2 / DigitalOcean Spaces. Empty = real AWS.
            endpoint: process.env.DOC_S3_ENDPOINT || undefined,
            forcePathStyle: process.env.DOC_S3_FORCE_PATH_STYLE === 'true', // MinIO needs this
            accessKeyId: process.env.DOC_S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.DOC_S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY,
            // Server-side-encryption header for objects at rest (e.g. 'AES256' or 'aws:kms').
            // Independent of the app-level envelope encryption below.
            serverSideEncryption: process.env.DOC_S3_SSE || undefined,
            kmsKeyId: process.env.DOC_S3_KMS_KEY_ID || undefined,
        },
        // App-level envelope encryption (AES-256-GCM). 32-byte master key, base64.
        // When set, every stored object is encrypted before it touches the storage
        // backend and downloads stream back through the app (presigned URLs are only
        // issued for unencrypted objects). Generate: `openssl rand -base64 32`.
        encryptionKey: process.env.DOCUMENT_ENCRYPTION_KEY || null,
        // Reject uploads larger than this (bytes). Default 25 MiB.
        maxUploadBytes: Number(process.env.DOC_MAX_UPLOAD_BYTES || 25 * 1024 * 1024),
        // Presigned download-URL lifetime (seconds).
        signedUrlTtlSeconds: Number(process.env.DOC_SIGNED_URL_TTL || 300),
        // Virus-scan engine: 'clamav' (real, lazy) | 'none' (placeholder hook). The
        // placeholder still rejects EICAR test files so the gate is demonstrably live.
        virusScanProvider: (process.env.DOC_VIRUS_SCAN_PROVIDER || 'none').toLowerCase(),
        clamav: {
            host: process.env.CLAMAV_HOST || '127.0.0.1',
            port: Number(process.env.CLAMAV_PORT || 3310),
            timeoutMs: Number(process.env.CLAMAV_TIMEOUT_MS || 15000),
        },
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
