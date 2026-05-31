'use strict';
/**
 * Provider abstraction layer. Registers external integrations behind a uniform
 * interface (health + mode), validates required/optional secrets, and reports
 * sandbox/live mode. Real providers implement live calls with graceful fallback;
 * unconfigured providers run in 'simulated' mode until their key is supplied.
 */
const fx = require('./fx');
const tracking = require('./tracking');
const esign = require('./esign');

// Declared integrations + the env key that activates 'live' mode.
const REGISTRY = [
    { name: 'fx', key: null, note: 'Frankfurter/ECB — keyless live FX', impl: fx },
    { name: 'email', key: 'EMAIL_API_KEY', note: 'Transactional email (e.g. Postmark/SES)' },
    { name: 'sms', key: 'SMS_API_KEY', note: 'SMS delivery (e.g. Twilio)' },
    { name: 'storage', key: 'STORAGE_BUCKET', note: 'Object storage for uploads (e.g. S3/GCS)' },
    { name: 'ai', key: 'GEMINI_API_KEY', note: 'Genkit/Gemini AI flows' },
    { name: 'ocr', key: 'OCR_API_KEY', note: 'Document OCR/extraction' },
    { name: 'tracking', key: 'TRACKING_API_KEY', note: 'Carrier shipment tracking (live aggregator or simulated)', impl: tracking },
    { name: 'esign', key: 'ESIGN_API_KEY', note: 'E-signature for B/L + contracts (DocuSeal/Adobe Sign)', impl: esign },
];

function mode(entry) {
    if (!entry.key) return 'live';                 // keyless live provider
    return process.env[entry.key] ? 'live' : 'simulated';
}

// Boot-time secret report (non-fatal): which providers are live vs simulated.
function validateEnv() {
    const required = ['JWT_ACCESS_SECRET', 'DB_NAME', 'DB_USER'];
    const missingRequired = required.filter((k) => !process.env[k]);
    const providers = REGISTRY.map((e) => ({ name: e.name, mode: mode(e), key: e.key, note: e.note }));
    return {
        missingRequired,
        weakSecret: !process.env.JWT_ACCESS_SECRET || process.env.JWT_ACCESS_SECRET === 'replace-with-strong-secret',
        providers,
    };
}

function logEnvReport() {
    const r = validateEnv();
    if (r.missingRequired.length) console.warn('[providers] MISSING required env:', r.missingRequired.join(', '));
    if (r.weakSecret) console.warn('[providers] WARNING: JWT_ACCESS_SECRET is unset/default — set a strong secret before production.');
    const live = r.providers.filter((p) => p.mode === 'live').map((p) => p.name);
    const sim = r.providers.filter((p) => p.mode === 'simulated').map((p) => p.name);
    console.log(`[providers] live: ${live.join(', ') || 'none'} | simulated (awaiting keys): ${sim.join(', ') || 'none'}`);
}

async function healthAll() {
    const live = await fx.health();
    const others = REGISTRY.filter((e) => e.key).map((e) => ({
        name: e.name, mode: mode(e), healthy: mode(e) === 'live', note: e.note,
    }));
    const cache = require('../cache'); // eslint-disable-line global-require
    return { generatedAt: new Date().toISOString(), cache: cache.health(), providers: [live, ...others] };
}

module.exports = { fx, tracking, esign, validateEnv, logEnvReport, healthAll, REGISTRY };
