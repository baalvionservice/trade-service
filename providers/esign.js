'use strict';
/**
 * E-signature provider seam (used by Digital B/L + Smart Contracts). Live mode (ESIGN_API_KEY set)
 * would call a real e-sign service (DocuSeal / Adobe Sign / DocuSign); until then it produces a
 * deterministic, verifiable simulated signature (HMAC over the signing context). Pure, no I/O in sim.
 */
const crypto = require('crypto');

const mode = () => (process.env.ESIGN_API_KEY ? 'live' : 'simulated');

// Returns a signature record { party, role, signedAt, signatureHash, provider }.
function sign({ documentId, party, role }) {
    const signedAt = new Date().toISOString();
    const payload = `${documentId}|${party}|${role}|${signedAt}`;
    const secret = process.env.ESIGN_SECRET || 'dev_esign_secret';
    const signatureHash = 'sha256:' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return { party, role, signedAt, signatureHash, provider: mode() };
}

function health() { return { name: 'esign', mode: mode(), healthy: true }; }

module.exports = { sign, health, mode };
