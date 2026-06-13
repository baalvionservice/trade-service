'use strict';
/**
 * Virus-scan hook (War Room 4, Prompt 4).
 *
 * A provider-agnostic seam the upload pipeline calls AFTER an object is stored but
 * BEFORE the document is released to 'available'. Two backends:
 *
 *   • 'clamav'  — real streaming scan against a clamd daemon (INSTREAM protocol),
 *                 lazy-connected so dev installs that don't run ClamAV never pay for it.
 *   • 'none'    — PLACEHOLDER. It is NOT a no-op: it still rejects the EICAR
 *                 anti-malware test file, so the quarantine gate is demonstrably
 *                 wired end-to-end. Anything else returns 'skipped' (treated as
 *                 passing) with a clear marker that no real engine ran.
 *
 * Swapping in a hosted scanner (VirusTotal, Cloudmersive, S3 malware scanning, etc.)
 * is a matter of adding one branch here — the rest of the engine is unchanged.
 */
const net = require('net');
const config = require('../config/appConfig');
const logger = require('../service/logger');

// The 68-byte EICAR test signature, assembled at runtime so this source file itself
// never trips a scanner. Detecting it proves the gate works without real malware.
const EICAR = [
    'X5O!P%@AP[4\\PZX54(P^)7CC)7}',
    '$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
].join('');

function containsEicar(buffer) {
    // EICAR must appear at the very start of the file to be a valid test vector.
    return buffer.slice(0, 128).toString('latin1').includes(EICAR);
}

/** Stream a buffer to clamd over the INSTREAM command. Resolves clamd's verdict. */
function clamavScan(buffer) {
    const { host, port, timeoutMs } = config.documents.clamav;
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host, port });
        let response = '';
        const timer = setTimeout(() => { socket.destroy(); reject(new Error('clamav_timeout')); }, timeoutMs);

        socket.on('connect', () => {
            socket.write('zINSTREAM\0');
            // INSTREAM framing: 4-byte big-endian length prefix per chunk, then a zero-length terminator.
            const CHUNK = 64 * 1024;
            for (let i = 0; i < buffer.length; i += CHUNK) {
                const slice = buffer.slice(i, i + CHUNK);
                const size = Buffer.alloc(4);
                size.writeUInt32BE(slice.length, 0);
                socket.write(size);
                socket.write(slice);
            }
            const end = Buffer.alloc(4);
            end.writeUInt32BE(0, 0);
            socket.write(end);
        });
        socket.on('data', (d) => { response += d.toString('utf8'); });
        socket.on('error', (e) => { clearTimeout(timer); reject(e); });
        socket.on('end', () => {
            clearTimeout(timer);
            const clean = /:\s*OK\b/.test(response);
            const found = response.match(/:\s*(.+)\s+FOUND\b/);
            if (found) return resolve({ status: 'infected', signature: found[1].trim() });
            if (clean) return resolve({ status: 'clean', signature: null });
            return resolve({ status: 'error', signature: null, raw: response.trim() });
        });
    });
}

/**
 * Scan a buffer. Always resolves (never throws) so a scanner outage degrades to a
 * recorded 'error' the operator can retry, rather than losing the upload.
 * @param {Buffer} buffer
 * @param {{ fileName?: string }} [meta]
 * @returns {Promise<{ status: 'clean'|'infected'|'error'|'skipped', engine: string, signature: string|null, raw?: string }>}
 */
async function scan(buffer, meta = {}) {
    // EICAR is rejected regardless of backend — the universal test vector.
    if (containsEicar(buffer)) {
        return { status: 'infected', engine: 'eicar-detector', signature: 'EICAR-Test-File' };
    }

    const provider = config.documents.virusScanProvider;
    if (provider === 'clamav') {
        try {
            const r = await clamavScan(buffer);
            return { ...r, engine: 'clamav' };
        } catch (err) {
            logger.error('ClamAV scan failed', { error: err.message, fileName: meta.fileName });
            return { status: 'error', engine: 'clamav', signature: null, raw: err.message };
        }
    }

    // Placeholder backend: no real engine configured.
    return { status: 'skipped', engine: 'placeholder', signature: null, raw: 'No virus-scan provider configured (DOC_VIRUS_SCAN_PROVIDER=none)' };
}

/** Verdicts that allow a document to be released to 'available'. */
function isPassing(status) {
    return status === 'clean' || status === 'skipped';
}

module.exports = { scan, isPassing, containsEicar, EICAR };
