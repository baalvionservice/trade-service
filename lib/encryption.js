'use strict';
/**
 * Document envelope encryption — AES-256-GCM application-level encryption for the
 * Document Management file engine (War Room 4, Prompt 4).
 *
 * Every stored object is encrypted with a 256-bit master key (config.documents.
 * encryptionKey, base64) and a fresh random 96-bit IV. GCM gives us authenticated
 * encryption: the 128-bit auth tag is verified on decrypt, so any tampering with
 * the ciphertext at rest (or a wrong key) fails closed instead of returning garbage.
 *
 * The IV + tag are NOT secret and are stored alongside the version row
 * (encryption_iv / encryption_tag). `keyId` is a non-secret fingerprint of the
 * master key so we can tell which key sealed an object after a key rotation — the
 * key material itself is never persisted or logged.
 *
 * When no key is configured the module degrades to a transparent 'none' passthrough
 * (plaintext at rest) so local dev works without ceremony; production should always
 * set DOCUMENT_ENCRYPTION_KEY (or rely on storage-layer SSE).
 */
const crypto = require('crypto');
const config = require('../config/appConfig');
const logger = require('../service/logger');

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;          // 96-bit nonce — the GCM-recommended size
const KEY_BYTES = 32;         // 256-bit key
const AAD = Buffer.from('baalvion:trade:document:v1'); // additional authenticated data

let warnedMissingKey = false;

/** Resolve + validate the master key once. Returns a 32-byte Buffer or null. */
function resolveKey() {
    const raw = config.documents.encryptionKey;
    if (!raw) return null;
    let key;
    try {
        key = Buffer.from(String(raw), 'base64');
    } catch {
        throw new Error('DOCUMENT_ENCRYPTION_KEY is not valid base64');
    }
    if (key.length !== KEY_BYTES) {
        throw new Error(`DOCUMENT_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}); generate with: openssl rand -base64 32`);
    }
    return key;
}

/** True when app-level envelope encryption is active. */
function isEnabled() {
    return Boolean(config.documents.encryptionKey);
}

/** Non-secret fingerprint of the active key (first 16 hex chars of its SHA-256). */
function keyId() {
    const key = resolveKey();
    if (!key) return null;
    return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * Encrypt a plaintext Buffer. Returns the sealed payload plus the metadata the
 * caller must persist to decrypt later.
 * @param {Buffer} plaintext
 * @returns {{ ciphertext: Buffer, algo: string, iv: string|null, tag: string|null, keyId: string|null }}
 */
function encrypt(plaintext) {
    if (!Buffer.isBuffer(plaintext)) throw new Error('encrypt() expects a Buffer');
    const key = resolveKey();
    if (!key) {
        if (!warnedMissingKey && config.env === 'production') {
            warnedMissingKey = true;
            logger.warn('Document encryption is OFF (DOCUMENT_ENCRYPTION_KEY unset) — objects stored as plaintext');
        }
        return { ciphertext: plaintext, algo: 'none', iv: null, tag: null, keyId: null };
    }
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGO, key, iv, { authTagLength: 16 });
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
        ciphertext,
        algo: 'AES-256-GCM',
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        keyId: keyId(),
    };
}

/**
 * Decrypt a sealed payload. Throws on any tamper / wrong-key (GCM tag mismatch).
 * @param {{ ciphertext: Buffer, algo: string, iv?: string, tag?: string }} sealed
 * @returns {Buffer} plaintext
 */
function decrypt(sealed) {
    const { ciphertext, algo, iv, tag } = sealed || {};
    if (!Buffer.isBuffer(ciphertext)) throw new Error('decrypt() expects ciphertext Buffer');
    if (!algo || algo === 'none') return ciphertext; // stored as plaintext
    if (algo !== 'AES-256-GCM') throw new Error(`Unsupported document encryption algo: ${algo}`);
    const key = resolveKey();
    if (!key) throw new Error('Cannot decrypt: DOCUMENT_ENCRYPTION_KEY is not configured');
    if (!iv || !tag) throw new Error('Cannot decrypt: missing IV or auth tag');
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(iv, 'base64'), { authTagLength: 16 });
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

module.exports = { isEnabled, keyId, encrypt, decrypt, ALGO };
