'use strict';
/**
 * Document validation pipeline — the gate every upload passes before it is stored
 * (War Room 4, Prompt 4). Never trust the client-declared content-type or filename:
 * we sniff the real type from the leading magic bytes, enforce a MIME allowlist and
 * a size ceiling, and sanitize the filename to defeat path traversal.
 */
const path = require('path');
const config = require('../config/appConfig');

// ── Trade document taxonomy ──────────────────────────────────────────────────
// The five first-class trade documents plus an escape hatch. These map 1:1 to the
// doc_type CHECK constraint in migration 011.
const DOC_TYPES = Object.freeze([
    'commercial_invoice',   // Invoice
    'packing_list',         // Packing List
    'bill_of_lading',       // Bill of Lading
    'certificate_of_origin',// Certificate of Origin
    'insurance_document',   // Insurance Docs
    'other',
]);

const CLASSIFICATIONS = Object.freeze(['PUBLIC', 'OPERATIONAL', 'CONFIDENTIAL', 'RESTRICTED']);

// ── MIME allowlist (trade documents are PDFs, scans, office files) ───────────
const ALLOWED_MIME = Object.freeze([
    'application/pdf',
    'image/png', 'image/jpeg', 'image/tiff', 'image/gif', 'image/webp',
    'application/msword',                                                        // .doc
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',   // .docx
    'application/vnd.ms-excel',                                                  // .xls
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',         // .xlsx
    'text/csv', 'text/plain', 'application/xml', 'text/xml',
]);

// Office Open XML + legacy Office share container magic bytes (ZIP / OLE2), so a
// detected container is accepted when the declared office MIME is on the allowlist.
const ZIP_OFFICE = new Set([
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const OLE_OFFICE = new Set(['application/msword', 'application/vnd.ms-excel']);
const TEXTUAL = new Set(['text/csv', 'text/plain', 'application/xml', 'text/xml']);

// Control characters (NUL–US plus DEL) — built without embedding literal bytes.
const CONTROL_CHARS = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + String.fromCharCode(127) + ']', 'g');

/**
 * Sniff a content-type from the first bytes of the buffer. Returns a canonical MIME
 * string, or null when the signature is unrecognised.
 * @param {Buffer} buf
 * @returns {string|null}
 */
function sniffMimeType(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
    const b = buf;
    const startsWith = (sig) => sig.every((byte, i) => b[i] === byte);

    if (startsWith([0x25, 0x50, 0x44, 0x46])) return 'application/pdf';                 // %PDF
    if (startsWith([0x89, 0x50, 0x4e, 0x47])) return 'image/png';                       // \x89PNG
    if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg';                            // JPEG SOI
    if (startsWith([0x47, 0x49, 0x46, 0x38])) return 'image/gif';                       // GIF8
    if (startsWith([0x49, 0x49, 0x2a, 0x00]) || startsWith([0x4d, 0x4d, 0x00, 0x2a])) return 'image/tiff'; // II*. / MM.*
    if (b.length >= 12 && startsWith([0x52, 0x49, 0x46, 0x46]) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'; // RIFF....WEBP
    if (startsWith([0x50, 0x4b, 0x03, 0x04]) || startsWith([0x50, 0x4b, 0x05, 0x06])) return 'application/zip'; // PK.. (docx/xlsx container)
    if (startsWith([0xd0, 0xcf, 0x11, 0xe0])) return 'application/x-ole-storage';       // OLE2 (legacy .doc/.xls)
    return null;
}

/** Does the sniffed signature corroborate the declared MIME? */
function signatureMatchesDeclared(detected, declared) {
    if (!declared) return Boolean(detected);
    if (detected === declared) return true;
    if (!detected) return false;
    if (detected === 'application/zip' && ZIP_OFFICE.has(declared)) return true;
    if (detected === 'application/x-ole-storage' && OLE_OFFICE.has(declared)) return true;
    return false;
}

/**
 * Sanitize a user-supplied filename: drop any directory component, strip control
 * and shell-hostile characters, collapse whitespace, and cap the length. Always
 * returns a non-empty, storage-safe basename.
 * @param {string} name
 * @returns {string}
 */
function sanitizeFileName(name) {
    const base = path.basename(String(name || '').replace(/\\/g, '/'));
    const cleaned = base
        .replace(CONTROL_CHARS, '')                 // control chars
        .replace(/[<>:"/\\|?*]/g, '_')              // path / shell metacharacters
        .replace(/\s+/g, ' ')
        .replace(/^\.+/, '')                        // no leading dots (hidden / traversal)
        .trim()
        .slice(0, 200);
    return cleaned || 'document';
}

/**
 * Run the full validation pipeline over an upload.
 * @param {{ buffer: Buffer, fileName?: string, declaredMime?: string, docType?: string }} input
 * @returns {{ ok: boolean, errors: string[], detectedMime: string|null, safeFileName: string, byteSize: number }}
 */
function validateUpload({ buffer, fileName, declaredMime, docType } = {}) {
    const errors = [];

    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        return { ok: false, errors: ['Empty upload — request body must contain file bytes'], detectedMime: null, safeFileName: sanitizeFileName(fileName), byteSize: 0 };
    }

    const byteSize = buffer.length;
    const max = config.documents.maxUploadBytes;
    if (byteSize > max) {
        errors.push(`File is ${byteSize} bytes; exceeds the ${max}-byte limit`);
    }

    if (docType !== undefined && docType !== null && !DOC_TYPES.includes(docType)) {
        errors.push(`Unknown doc_type "${docType}" (allowed: ${DOC_TYPES.join(', ')})`);
    }

    const detectedMime = sniffMimeType(buffer);
    const declared = declaredMime && String(declaredMime).split(';')[0].trim().toLowerCase();

    // A declared MIME (when present) must be on the allowlist.
    if (declared && !ALLOWED_MIME.includes(declared)) {
        errors.push(`Content type "${declared}" is not allowed`);
    }

    // The sniffed signature must corroborate the declaration — blocks a .pdf-named
    // executable or a content-type spoof. Textual files (no magic) are exempt.
    if (declared && !TEXTUAL.has(declared) && !signatureMatchesDeclared(detectedMime, declared)) {
        errors.push(`File signature (${detectedMime || 'unrecognised'}) does not match declared type "${declared}"`);
    }

    // No declaration: the sniffed type alone must be recognised + allowlisted.
    if (!declared) {
        const effective = detectedMime === 'application/zip' || detectedMime === 'application/x-ole-storage' ? null : detectedMime;
        if (!effective || !ALLOWED_MIME.includes(effective)) {
            errors.push('Could not determine an allowed content type from the file signature; provide a Content-Type header');
        }
    }

    return {
        ok: errors.length === 0,
        errors,
        detectedMime,
        safeFileName: sanitizeFileName(fileName),
        byteSize,
    };
}

module.exports = {
    DOC_TYPES,
    CLASSIFICATIONS,
    ALLOWED_MIME,
    sniffMimeType,
    sanitizeFileName,
    signatureMatchesDeclared,
    validateUpload,
};
