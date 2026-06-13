'use strict';
/**
 * Document engine — the orchestration core of the Document Management System
 * (War Room 4, Prompt 4). It composes the building blocks into the secure
 * upload → store → scan → release pipeline and owns all writes to the three
 * tradeops document tables.
 *
 * Upload pipeline (addVersion):
 *   1. VALIDATE   — size, MIME allowlist, magic-byte sniff, filename sanitization.
 *   2. EXTRACT    — structural metadata + plaintext SHA-256 (integrity hash).
 *   3. ENCRYPT    — AES-256-GCM envelope (when a key is configured).
 *   4. STORE      — write the (cipher)text to S3-compatible / local object storage.
 *   5. PERSIST    — append an immutable version row, advance the document pointer,
 *                   and move the document to `scanning`, all in one transaction.
 *   6. SCAN       — enqueue an async virus scan; the worker releases the document
 *                   to `available` (clean/skipped) or `quarantined` (infected).
 *
 * Every model write happens inside db.sequelize.transaction(), which index.js wraps
 * to stamp the tenant RLS GUCs from the request's AsyncLocalStorage context — so the
 * engine is correct under both the owner connection and the baalvion_app role.
 */
const crypto = require('crypto');
const db = require('../../models');
const { getStorage, buildObjectKey } = require('../../lib/storage');
const encryption = require('../../lib/encryption');
const { validateUpload } = require('../../lib/documentValidation');
const { extract } = require('../../lib/metadataExtraction');
const { enqueue } = require('../../queue');
const logger = require('../logger');
const { AppError } = require('../../utils/errors');

const SCAN_QUEUE = 'document_scan';

/** Append a chain-of-custody event. Best-effort: never fails the caller. */
async function recordEvent({ documentId, versionId = null, tenantId, eventType, actor, detail = {} }, transaction) {
    try {
        return await db.DocumentEvent.create(
            { document_id: documentId, version_id: versionId, tenant_id: tenantId, event_type: eventType, actor: actor || 'system', detail },
            transaction ? { transaction } : {},
        );
    } catch (err) {
        logger.error('Failed to record document event', { eventType, documentId, error: err.message });
        return null;
    }
}

/** Create a logical document (no file yet → status 'draft'). */
async function createDocument(input) {
    const {
        tenantId, docType, title = null, description = null, classification = 'OPERATIONAL',
        shipmentId = null, tradeOperationId = null, issuedAt = null, expiresAt = null,
        metadata = {}, actor = 'system',
    } = input;

    return db.sequelize.transaction(async (t) => {
        const doc = await db.TradeDocument.create({
            tenant_id: tenantId,
            doc_type: docType,
            title,
            description,
            classification,
            shipment_id: shipmentId,
            trade_operation_id: tradeOperationId,
            issued_at: issuedAt,
            expires_at: expiresAt,
            metadata,
            status: 'draft',
            created_by: actor,
        }, { transaction: t });
        await recordEvent({ documentId: doc.id, tenantId: doc.tenant_id, eventType: 'created', actor, detail: { docType, classification } }, t);
        return doc;
    });
}

/**
 * Upload a new version of an existing document — the file-engine entry point.
 * @returns {Promise<{ document, version }>}
 */
async function addVersion(input) {
    const { document, buffer, fileName, declaredMime, actor = 'system' } = input;

    // 1. VALIDATE ------------------------------------------------------------
    const validation = validateUpload({ buffer, fileName, declaredMime, docType: document.doc_type });
    if (!validation.ok) {
        throw new AppError('INVALID_UPLOAD', 'Upload failed validation', 422, { errors: validation.errors });
    }
    const { detectedMime, safeFileName, byteSize } = validation;
    const effectiveMime = (declaredMime && String(declaredMime).split(';')[0].trim().toLowerCase()) || detectedMime || 'application/octet-stream';

    // 2. EXTRACT -------------------------------------------------------------
    const extracted = extract({ buffer, mimeType: effectiveMime, detectedMime, fileName: safeFileName });
    const sha256 = extracted.sha256;

    // 3. ENCRYPT -------------------------------------------------------------
    const sealed = encryption.encrypt(buffer);

    // 4. STORE (outside the txn — object storage is not transactional) -------
    // Pre-generate the version row's UUID so the object key is stable + unique per
    // upload attempt; concurrent uploads to the same document never share a key.
    const storage = getStorage();
    const versionId = crypto.randomUUID();
    const storageKey = buildObjectKey({ tenantId: document.tenant_id, documentId: document.id, versionId, fileName: safeFileName });
    let stored;
    try {
        stored = await storage.put(storageKey, sealed.ciphertext, {
            contentType: sealed.algo === 'none' ? effectiveMime : 'application/octet-stream',
            metadata: { tenant: String(document.tenant_id), document: String(document.id), sha256 },
        });
    } catch (err) {
        logger.error('Object storage write failed', { documentId: document.id, error: err.message });
        throw new AppError('STORAGE_FAILED', 'Failed to store the uploaded file', 502, { reason: err.message });
    }

    // 5. PERSIST -------------------------------------------------------------
    let version;
    try {
        version = await db.sequelize.transaction(async (t) => {
            // Lock the document row so concurrent uploads get distinct version numbers.
            const locked = await db.TradeDocument.findByPk(document.id, { transaction: t, lock: t.LOCK.UPDATE });
            if (!locked) throw new AppError('NOT_FOUND', 'Document not found', 404);
            const versionNo = (locked.current_version || 0) + 1;

            const row = await db.DocumentVersion.create({
                id: versionId, // pre-generated so it matches the stored object key
                tenant_id: locked.tenant_id,
                document_id: locked.id,
                version_no: versionNo,
                file_name: safeFileName,
                original_file_name: fileName || null,
                mime_type: effectiveMime,
                detected_mime_type: detectedMime,
                file_size_bytes: byteSize,
                sha256,
                storage_provider: stored.provider,
                storage_bucket: stored.bucket,
                storage_key: storageKey,
                encryption_algo: sealed.algo,
                encryption_key_id: sealed.keyId,
                encryption_iv: sealed.iv,
                encryption_tag: sealed.tag,
                scan_status: 'pending',
                extracted_metadata: extracted,
                uploaded_by: actor,
            }, { transaction: t });

            locked.current_version = versionNo;
            locked.latest_version_id = row.id;
            locked.status = 'scanning';
            locked.updated_by = actor;
            await locked.save({ transaction: t });

            await recordEvent({
                documentId: locked.id, versionId: row.id, tenantId: locked.tenant_id,
                eventType: 'version_uploaded', actor,
                detail: { versionNo, byteSize, mime: effectiveMime, sha256, encrypted: sealed.algo !== 'none' },
            }, t);

            return row;
        });
    } catch (err) {
        // Roll back the orphaned object so a failed persist doesn't leak storage.
        try { await storage.remove(storageKey); } catch { /* best-effort cleanup */ }
        throw err;
    }

    // 6. SCAN (async, best-effort enqueue) -----------------------------------
    try {
        await enqueue(SCAN_QUEUE, 'scan', { versionId: version.id, documentId: document.id, tenantId: document.tenant_id }, { jobId: `scan:${version.id}` });
    } catch (err) {
        logger.error('Failed to enqueue virus scan', { versionId: version.id, error: err.message });
        await recordEvent({ documentId: document.id, versionId: version.id, tenantId: document.tenant_id, eventType: 'scan_enqueue_failed', actor, detail: { reason: err.message } });
    }

    const refreshed = await db.TradeDocument.findByPk(document.id);
    return { document: refreshed, version };
}

/**
 * Apply a virus-scan verdict to a version and release/quarantine the document.
 * Called by the scan worker (under a system bypass context). Idempotent.
 */
async function applyScanResult({ versionId, status, engine, signature = null, raw = {}, isPassing, actor = 'scanner' }) {
    return db.sequelize.transaction(async (t) => {
        const version = await db.DocumentVersion.findByPk(versionId, { transaction: t, lock: t.LOCK.UPDATE });
        if (!version) throw new AppError('NOT_FOUND', 'Version not found', 404);

        version.scan_status = status;
        version.scan_engine = engine;
        version.scan_signature = signature;
        version.scan_result = raw || {};
        version.scanned_at = new Date();
        await version.save({ transaction: t });

        const doc = await db.TradeDocument.findByPk(version.document_id, { transaction: t, lock: t.LOCK.UPDATE });
        // Only the latest version's verdict drives the document status.
        if (doc && doc.latest_version_id === version.id && doc.status === 'scanning') {
            doc.status = isPassing ? 'available' : 'quarantined';
            await doc.save({ transaction: t });
        }

        await recordEvent({
            documentId: version.document_id, versionId: version.id, tenantId: version.tenant_id,
            eventType: 'scan_completed', actor,
            detail: { status, engine, signature, released: isPassing },
        }, t);

        return { version, document: doc };
    });
}

/** Fetch and decrypt a version's plaintext bytes (download path). */
async function fetchPlaintext(version) {
    const storage = getStorage();
    const ciphertext = await storage.get(version.storage_key);
    return encryption.decrypt({
        ciphertext,
        algo: version.encryption_algo,
        iv: version.encryption_iv,
        tag: version.encryption_tag,
    });
}

/** Re-enqueue a scan for a version stuck in 'pending' (admin recovery). */
async function rescan(version) {
    await enqueue(SCAN_QUEUE, 'scan', { versionId: version.id, documentId: version.document_id, tenantId: version.tenant_id }, { jobId: `scan:${version.id}:retry:${Date.now()}` });
}

module.exports = {
    SCAN_QUEUE,
    createDocument,
    addVersion,
    applyScanResult,
    fetchPlaintext,
    rescan,
    recordEvent,
};
