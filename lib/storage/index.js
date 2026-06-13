'use strict';
/**
 * Storage factory for the document engine. Selects the object-store driver from
 * config.documents.storageProvider and memoizes it. Every driver implements the
 * same contract:
 *
 *   name: string
 *   put(key, buffer, { contentType, metadata }) -> { provider, bucket, key, etag, size }
 *   get(key) -> Promise<Buffer>
 *   remove(key) -> Promise<void>
 *   exists(key) -> Promise<boolean>
 *   getSignedDownloadUrl(key, { expiresIn, fileName, contentType }) -> Promise<string|null>
 *   createReadStream?(key)   // local only
 *
 * Business code depends on this contract, never on a concrete driver — swapping
 * local↔S3 is a single env var (DOC_STORAGE_PROVIDER) with no code change.
 */
const config = require('../../config/appConfig');

let cached = null;

function getStorage() {
    if (cached) return cached;
    const provider = config.documents.storageProvider;
    switch (provider) {
        case 's3':
            cached = require('./s3Provider');
            break;
        case 'local':
            cached = require('./localProvider');
            break;
        default:
            throw new Error(`Unknown DOC_STORAGE_PROVIDER "${provider}" (expected 'local' or 's3')`);
    }
    return cached;
}

/**
 * Build the canonical object key for a document version. Tenant-prefixed so a
 * single bucket can host every tenant with clear isolation in the key space. The
 * versionId (the version row's UUID) makes the key unique per upload attempt, so
 * concurrent uploads to the same document can never collide on the same object —
 * the human-friendly version_no lives in the DB row, not the key.
 */
function buildObjectKey({ tenantId, documentId, versionId, fileName }) {
    const safeTenant = String(tenantId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeName = String(fileName || 'document').replace(/[^a-zA-Z0-9._-]/g, '_');
    return `tenants/${safeTenant}/documents/${documentId}/versions/${versionId}/${safeName}`;
}

// Test seam: reset the memoized driver (used when tests flip the provider).
function _reset() { cached = null; }

module.exports = { getStorage, buildObjectKey, _reset };
