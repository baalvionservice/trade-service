'use strict';
/**
 * Document Management System — HTTP surface (War Room 4, Prompt 4).
 * Thin controller: validation + tenant ownership + delegation to the document engine.
 * Mirrors the ownership/admin-bypass pattern of workflowController.js.
 */
const db = require('../models');
const engine = require('../service/documents/documentEngine');
const { getStorage } = require('../lib/storage');
const { DOC_TYPES, CLASSIFICATIONS, ALLOWED_MIME } = require('../lib/documentValidation');
const encryption = require('../lib/encryption');
const config = require('../config/appConfig');
const { sendSuccess, sendPaginated } = require('../utils/response');
const { AppError } = require('../utils/errors');
const { recordAudit } = require('../utils/audit');

function isAdmin(req) {
    const roles = (req.auth && req.auth.roles) || (req.auth && req.auth.role ? [req.auth.role] : []);
    return roles.some((r) => r === 'admin' || r === 'super_admin' || r === 'owner');
}
function callerTenantId(req) {
    return (req.auth && (req.auth.tenantId || req.auth.orgId)) || req.tenantId || null;
}
function actorOf(req) {
    return (req.auth && (req.auth.userId || req.auth.email)) || 'system';
}

async function fetchDocumentOwned(id, req, next) {
    const doc = await db.TradeDocument.findByPk(id);
    if (!doc) { next(new AppError('NOT_FOUND', 'Document not found', 404)); return null; }
    if (isAdmin(req)) return doc;
    const tenantId = callerTenantId(req);
    if (tenantId && doc.tenant_id && doc.tenant_id !== tenantId) {
        next(new AppError('NOT_FOUND', 'Document not found', 404)); return null; // 404, not 403 (no existence leak)
    }
    return doc;
}

// Strip storage internals from version rows returned to clients.
function versionView(v) {
    const j = v.toJSON ? v.toJSON() : v;
    return {
        id: j.id,
        version_no: j.version_no,
        file_name: j.file_name,
        mime_type: j.mime_type,
        detected_mime_type: j.detected_mime_type,
        file_size_bytes: Number(j.file_size_bytes),
        sha256: j.sha256,
        storage_provider: j.storage_provider,
        encrypted: j.encryption_algo && j.encryption_algo !== 'none',
        encryption_algo: j.encryption_algo,
        scan_status: j.scan_status,
        scan_engine: j.scan_engine,
        scan_signature: j.scan_signature,
        scanned_at: j.scanned_at,
        extracted_metadata: j.extracted_metadata,
        uploaded_by: j.uploaded_by,
        created_at: j.created_at,
    };
}

// ── Definition endpoint: doc types, classifications, limits, capabilities ─────
const getCapabilities = (req, res) => sendSuccess(req, res, {
    doc_types: DOC_TYPES,
    classifications: CLASSIFICATIONS,
    allowed_mime_types: ALLOWED_MIME,
    max_upload_bytes: config.documents.maxUploadBytes,
    storage_provider: config.documents.storageProvider,
    encryption_enabled: encryption.isEnabled(),
    encryption_algo: encryption.isEnabled() ? 'AES-256-GCM' : 'none',
    virus_scan_provider: config.documents.virusScanProvider,
});

// ── Create a document (metadata only; upload a version next) ──────────────────
const createDocument = async (req, res, next) => {
    try {
        const tenantId = callerTenantId(req);
        if (!tenantId && !isAdmin(req)) return next(new AppError('TENANT_REQUIRED', 'No tenant context', 400));
        const {
            doc_type, title = null, description = null, classification = 'OPERATIONAL',
            shipment_id = null, trade_operation_id = null, issued_at = null, expires_at = null, metadata = {},
        } = req.body || {};

        if (!doc_type || !DOC_TYPES.includes(doc_type)) {
            return next(new AppError('INVALID_DOC_TYPE', '`doc_type` is required', 422, { allowed: DOC_TYPES }));
        }
        if (classification && !CLASSIFICATIONS.includes(classification)) {
            return next(new AppError('INVALID_CLASSIFICATION', 'Invalid `classification`', 422, { allowed: CLASSIFICATIONS }));
        }

        // If bound to a shipment, ensure it exists in the caller's tenant.
        if (shipment_id) {
            const shipment = await db.TradeShipment.findByPk(shipment_id);
            if (!shipment) return next(new AppError('SHIPMENT_NOT_FOUND', 'Shipment not found', 404));
        }

        const doc = await engine.createDocument({
            tenantId: tenantId || (req.body && req.body.tenant_id) || 'T-DEMO',
            docType: doc_type,
            title,
            description,
            classification,
            shipmentId: shipment_id,
            tradeOperationId: trade_operation_id,
            issuedAt: issued_at,
            expiresAt: expires_at,
            metadata,
            actor: actorOf(req),
        });
        return sendSuccess(req, res, doc, 201);
    } catch (err) {
        return next(err);
    }
};

// ── List documents (tenant-scoped, filtered, paginated) ──────────────────────
const listDocuments = async (req, res, next) => {
    try {
        const { doc_type, status, classification, shipment_id, trade_operation_id, page = 1, limit = 20 } = req.query;
        const where = {};
        if (doc_type) where.doc_type = doc_type;
        if (status) where.status = status;
        if (classification) where.classification = classification;
        if (shipment_id) where.shipment_id = shipment_id;
        if (trade_operation_id) where.trade_operation_id = trade_operation_id;
        if (!isAdmin(req)) {
            const tenantId = callerTenantId(req);
            if (tenantId) where.tenant_id = tenantId;
        }
        const offset = (Number(page) - 1) * Number(limit);
        const { count, rows } = await db.TradeDocument.findAndCountAll({
            where, limit: Number(limit), offset, order: [['created_at', 'DESC']],
        });
        return sendPaginated(req, res, { items: rows, total: count, page: Number(page), limit: Number(limit) });
    } catch (err) {
        return next(err);
    }
};

// ── Document detail (+ versions) ──────────────────────────────────────────────
const getDocument = async (req, res, next) => {
    try {
        const doc = await fetchDocumentOwned(req.params.id, req, next);
        if (!doc) return undefined;
        const versions = await db.DocumentVersion.findAll({ where: { document_id: doc.id }, order: [['version_no', 'DESC']] });
        return sendSuccess(req, res, { ...doc.toJSON(), versions: versions.map(versionView) });
    } catch (err) {
        return next(err);
    }
};

// ── Upload a new version (the file-engine endpoint) ──────────────────────────
// Accepts raw binary body (preferred — any non-JSON Content-Type, original name in
// the X-File-Name header) OR a JSON envelope { file_base64, file_name, mime_type }.
const uploadVersion = async (req, res, next) => {
    try {
        const doc = await fetchDocumentOwned(req.params.id, req, next);
        if (!doc) return undefined;

        let buffer;
        let fileName;
        let declaredMime;

        if (Buffer.isBuffer(req.body) && req.body.length) {
            buffer = req.body;
            fileName = req.get('X-File-Name') || req.query.file_name || doc.title || 'document';
            declaredMime = req.get('Content-Type');
        } else if (req.body && typeof req.body === 'object' && req.body.file_base64) {
            buffer = Buffer.from(String(req.body.file_base64), 'base64');
            fileName = req.body.file_name || doc.title || 'document';
            declaredMime = req.body.mime_type || null;
        } else {
            return next(new AppError('EMPTY_UPLOAD', 'Provide file bytes as the raw request body (with Content-Type) or JSON { file_base64, file_name, mime_type }', 422));
        }

        const { document, version } = await engine.addVersion({
            document: doc,
            buffer,
            fileName,
            declaredMime,
            actor: actorOf(req),
        });

        await recordAudit({
            actorId: actorOf(req), action: 'document.version.uploaded', resourceType: 'document', resourceId: document.id,
            tenantId: document.tenant_id, metadata: { versionNo: version.version_no, docType: document.doc_type, bytes: Number(version.file_size_bytes) },
        });

        return sendSuccess(req, res, {
            document: { id: document.id, status: document.status, current_version: document.current_version },
            version: versionView(version),
            note: 'Stored and queued for virus scan; document becomes `available` once the scan passes.',
        }, 201);
    } catch (err) {
        return next(err);
    }
};

// ── List versions ─────────────────────────────────────────────────────────────
const listVersions = async (req, res, next) => {
    try {
        const doc = await fetchDocumentOwned(req.params.id, req, next);
        if (!doc) return undefined;
        const versions = await db.DocumentVersion.findAll({ where: { document_id: doc.id }, order: [['version_no', 'DESC']] });
        return sendSuccess(req, res, versions.map(versionView));
    } catch (err) {
        return next(err);
    }
};

// ── Resolve which version to download (default: latest; ?version=N or :versionId) ──
async function resolveVersion(doc, { versionNo, versionId }) {
    if (versionId) return db.DocumentVersion.findOne({ where: { id: versionId, document_id: doc.id } });
    if (versionNo) return db.DocumentVersion.findOne({ where: { document_id: doc.id, version_no: Number(versionNo) } });
    if (doc.latest_version_id) return db.DocumentVersion.findByPk(doc.latest_version_id);
    return db.DocumentVersion.findOne({ where: { document_id: doc.id }, order: [['version_no', 'DESC']] });
}

// ── Download — presigned URL for unencrypted objects, else stream through app ──
const downloadVersion = async (req, res, next) => {
    try {
        const doc = await fetchDocumentOwned(req.params.id, req, next);
        if (!doc) return undefined;

        const version = await resolveVersion(doc, { versionNo: req.query.version, versionId: req.params.versionId });
        if (!version) return next(new AppError('NOT_FOUND', 'Version not found', 404));

        // Safety gate: never serve a quarantined / unscanned object.
        if (doc.status === 'quarantined' || version.scan_status === 'infected') {
            return next(new AppError('QUARANTINED', 'This document is quarantined and cannot be downloaded', 403));
        }
        if (version.scan_status === 'pending') {
            return next(new AppError('SCAN_PENDING', 'Virus scan is still in progress; try again shortly', 409));
        }

        await recordAudit({
            actorId: actorOf(req), action: 'document.downloaded', resourceType: 'document', resourceId: doc.id,
            tenantId: doc.tenant_id, metadata: { versionId: version.id, versionNo: version.version_no },
        });
        await engine.recordEvent({ documentId: doc.id, versionId: version.id, tenantId: doc.tenant_id, eventType: 'downloaded', actor: actorOf(req), detail: { versionNo: version.version_no } });

        const storage = getStorage();
        const isEncrypted = version.encryption_algo && version.encryption_algo !== 'none';

        // Encrypted objects MUST stream through the app (decrypt in-process) — a
        // presigned URL would hand the client ciphertext it cannot open.
        if (!isEncrypted && typeof storage.getSignedDownloadUrl === 'function') {
            const url = await storage.getSignedDownloadUrl(version.storage_key, {
                fileName: version.file_name, contentType: version.mime_type, expiresIn: config.documents.signedUrlTtlSeconds,
            });
            if (url) return sendSuccess(req, res, { mode: 'redirect', url, expires_in: config.documents.signedUrlTtlSeconds, file_name: version.file_name });
        }

        const bytes = await engine.fetchPlaintext(version);
        res.setHeader('Content-Type', version.mime_type || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${version.file_name.replace(/"/g, '')}"`);
        res.setHeader('Content-Length', bytes.length);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        return res.status(200).end(bytes);
    } catch (err) {
        return next(err);
    }
};

// ── Verify / reject (manual review outcome) ──────────────────────────────────
async function setStatus(req, res, next, status, action) {
    const doc = await fetchDocumentOwned(req.params.id, req, next);
    if (!doc) return undefined;
    if (status === 'verified' && doc.status === 'quarantined') {
        return next(new AppError('QUARANTINED', 'Cannot verify a quarantined document', 409));
    }
    doc.status = status;
    doc.updated_by = actorOf(req);
    await doc.save();
    await engine.recordEvent({ documentId: doc.id, tenantId: doc.tenant_id, eventType: action, actor: actorOf(req), detail: {} });
    await recordAudit({ actorId: actorOf(req), action: `document.${action}`, resourceType: 'document', resourceId: doc.id, tenantId: doc.tenant_id, metadata: {} });
    return sendSuccess(req, res, doc);
}
const verifyDocument = (req, res, next) => setStatus(req, res, next, 'verified', 'verified').catch(next);
const rejectDocument = (req, res, next) => setStatus(req, res, next, 'rejected', 'rejected').catch(next);

// ── Re-trigger a scan for a pending/errored version (admin recovery) ─────────
const rescanVersion = async (req, res, next) => {
    try {
        const doc = await fetchDocumentOwned(req.params.id, req, next);
        if (!doc) return undefined;
        const version = await resolveVersion(doc, { versionId: req.params.versionId, versionNo: req.query.version });
        if (!version) return next(new AppError('NOT_FOUND', 'Version not found', 404));
        await engine.rescan(version);
        return sendSuccess(req, res, { version_id: version.id, requeued: true });
    } catch (err) {
        return next(err);
    }
};

// ── Soft delete ───────────────────────────────────────────────────────────────
const deleteDocument = async (req, res, next) => {
    try {
        const doc = await fetchDocumentOwned(req.params.id, req, next);
        if (!doc) return undefined;
        doc.deleted_by = actorOf(req);
        await doc.save();
        await engine.recordEvent({ documentId: doc.id, tenantId: doc.tenant_id, eventType: 'deleted', actor: actorOf(req), detail: {} });
        await doc.destroy(); // paranoid soft delete
        await recordAudit({ actorId: actorOf(req), action: 'document.deleted', resourceType: 'document', resourceId: doc.id, tenantId: doc.tenant_id, metadata: {} });
        return sendSuccess(req, res, { id: doc.id, deleted: true });
    } catch (err) {
        return next(err);
    }
};

// ── Per-document chain of custody ─────────────────────────────────────────────
const listEvents = async (req, res, next) => {
    try {
        const doc = await fetchDocumentOwned(req.params.id, req, next);
        if (!doc) return undefined;
        const rows = await db.DocumentEvent.findAll({ where: { document_id: doc.id }, order: [['occurred_at', 'DESC']] });
        return sendSuccess(req, res, rows);
    } catch (err) {
        return next(err);
    }
};

module.exports = {
    getCapabilities,
    createDocument,
    listDocuments,
    getDocument,
    uploadVersion,
    listVersions,
    downloadVersion,
    verifyDocument,
    rejectDocument,
    rescanVersion,
    deleteDocument,
    listEvents,
};
