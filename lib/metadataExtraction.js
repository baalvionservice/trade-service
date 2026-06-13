'use strict';
/**
 * Metadata extraction — derives structural facts about an uploaded file directly
 * from its bytes (War Room 4, Prompt 4). Dependency-free on purpose: we parse just
 * enough of each container to populate document_versions.extracted_metadata without
 * pulling a heavy parsing stack into the hot upload path.
 */
const crypto = require('crypto');

/** SHA-256 hex digest of a buffer — the tamper-evidence hash stored per version. */
function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** Best-effort PDF facts: version, page count, encryption flag. */
function extractPdf(buf) {
    const out = { format: 'pdf' };
    const head = buf.slice(0, 1024).toString('latin1');
    const ver = head.match(/%PDF-(\d+\.\d+)/);
    if (ver) out.pdfVersion = ver[1];
    // Page count: count "/Type /Page" objects (not /Pages). Cheap + good enough for
    // an operational metadata badge; a precise count needs a full parser.
    const text = buf.toString('latin1');
    const pageMatches = text.match(/\/Type\s*\/Page[^s]/g);
    if (pageMatches) out.pageCount = pageMatches.length;
    out.encrypted = /\/Encrypt\b/.test(text);
    return out;
}

/** PNG dimensions from the IHDR chunk (bytes 16–24). */
function extractPng(buf) {
    const out = { format: 'png' };
    if (buf.length >= 24) {
        out.width = buf.readUInt32BE(16);
        out.height = buf.readUInt32BE(20);
    }
    return out;
}

/** JPEG dimensions by walking SOF markers. */
function extractJpeg(buf) {
    const out = { format: 'jpeg' };
    let offset = 2;
    while (offset + 9 < buf.length) {
        if (buf[offset] !== 0xff) { offset += 1; continue; }
        const marker = buf[offset + 1];
        // SOF0..SOF3 / SOF5..SOF7 / SOF9..SOF11 / SOF13..SOF15 carry frame dimensions.
        const isSof = (marker >= 0xc0 && marker <= 0xc3)
            || (marker >= 0xc5 && marker <= 0xc7)
            || (marker >= 0xc9 && marker <= 0xcb)
            || (marker >= 0xcd && marker <= 0xcf);
        if (isSof) {
            out.height = buf.readUInt16BE(offset + 5);
            out.width = buf.readUInt16BE(offset + 7);
            break;
        }
        const len = buf.readUInt16BE(offset + 2);
        if (len < 2) break;
        offset += 2 + len;
    }
    return out;
}

/**
 * Extract structural metadata for a file.
 * @param {{ buffer: Buffer, mimeType?: string, detectedMime?: string, fileName?: string }} input
 * @returns {object} extracted_metadata payload (always includes sha256 + byteSize)
 */
function extract({ buffer, mimeType, detectedMime, fileName } = {}) {
    const effective = detectedMime || mimeType || '';
    const base = {
        sha256: sha256(buffer),
        byteSize: buffer.length,
        detectedMime: detectedMime || null,
        extension: fileName && fileName.includes('.') ? fileName.split('.').pop().toLowerCase().slice(0, 12) : null,
    };
    try {
        if (effective === 'application/pdf') return { ...base, ...extractPdf(buffer) };
        if (effective === 'image/png') return { ...base, ...extractPng(buffer) };
        if (effective === 'image/jpeg') return { ...base, ...extractJpeg(buffer) };
    } catch {
        // Extraction is best-effort; a malformed container must never fail an upload.
        return { ...base, extractionError: true };
    }
    return base;
}

module.exports = { extract, sha256, extractPdf, extractPng, extractJpeg };
