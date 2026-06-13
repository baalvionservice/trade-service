'use strict';
/**
 * Local filesystem storage driver — the dev/test default for the document engine.
 * Writes objects under config.documents.localDir/<storage_key>. It deliberately does
 * NOT issue signed URLs (returns null), so the controller streams bytes back through
 * the app — the same code path used for encrypted objects on any backend.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const config = require('../../config/appConfig');

const ROOT = config.documents.localDir;

// Guard against path traversal: the resolved object path must stay under ROOT.
function resolveSafe(key) {
    const full = path.resolve(ROOT, key);
    const rootResolved = path.resolve(ROOT);
    if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) {
        throw new Error(`storage_key escapes storage root: ${key}`);
    }
    return full;
}

const name = 'local';

async function put(key, buffer, opts = {}) {
    const full = resolveSafe(key);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, buffer);
    return { provider: name, bucket: null, key, etag: null, size: buffer.length, contentType: opts.contentType || null };
}

async function get(key) {
    const full = resolveSafe(key);
    return fsp.readFile(full);
}

function createReadStream(key) {
    return fs.createReadStream(resolveSafe(key));
}

async function remove(key) {
    const full = resolveSafe(key);
    await fsp.rm(full, { force: true });
}

async function exists(key) {
    try { await fsp.access(resolveSafe(key)); return true; } catch { return false; }
}

// Local files are never publicly reachable — force the in-app streaming download path.
async function getSignedDownloadUrl() { return null; }

module.exports = { name, put, get, createReadStream, remove, exists, getSignedDownloadUrl };
