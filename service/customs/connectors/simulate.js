'use strict';
/**
 * Deterministic gateway SIMULATION (Prompt 9).
 *
 * The real ICEGATE / ACE / CDS / Mirsal endpoints need accredited credentials,
 * mutual-TLS and a sandbox enrolment we don't have in this environment — so each
 * connector's `transmit()` is wired to a REAL-HTTP seam that is dormant until its
 * endpoint env var is set, and otherwise falls back to this simulator.
 *
 * The simulator is fully DETERMINISTIC (no Math.random / Date entropy in the
 * decision) so the verify harness can assert the retry / failure-recovery /
 * normalization paths exactly. Behaviour is driven by `declaration.metadata.simulate`:
 *
 *   undefined | 'accept'   → accepted on the first attempt
 *   'pending'              → transmitted, async decision pending (status submitted)
 *   'reject'               → permanent business rejection (no retry)
 *   'transient'            → transient failure on EVERY attempt (exhausts retries)
 *   'flaky:N'              → transient failure for the first N attempts, then accept
 *                            (exercises the retry mechanism succeeding mid-burst)
 */

const { FAILURE_KIND } = require('../schema');

/**
 * Decide the simulated outcome for a transmission attempt.
 * @param {object} declaration  canonical declaration
 * @param {object} ctx          { attempt }
 * @returns {{ ok: boolean, mode?: string, kind?: string, code?: string, reason?: string }}
 */
function decideOutcome(declaration = {}, ctx = {}) {
    const attempt = Number(ctx.attempt) || 1;
    const raw = (declaration.metadata && declaration.metadata.simulate) || 'accept';
    const directive = String(raw).toLowerCase();

    if (directive === 'reject') {
        return { ok: false, kind: FAILURE_KIND.PERMANENT, code: 'GW_REJECTED', reason: 'declaration rejected by gateway rules' };
    }
    if (directive === 'transient') {
        return { ok: false, kind: FAILURE_KIND.TRANSIENT, code: 'GW_TIMEOUT', reason: 'gateway temporarily unavailable' };
    }
    if (directive.startsWith('flaky')) {
        const n = Number(directive.split(':')[1]) || 1;
        if (attempt <= n) {
            return { ok: false, kind: FAILURE_KIND.TRANSIENT, code: 'GW_TIMEOUT', reason: `gateway flaky (attempt ${attempt}/${n})` };
        }
        return { ok: true, mode: 'accept' };
    }
    if (directive === 'pending') {
        return { ok: true, mode: 'pending' };
    }
    return { ok: true, mode: 'accept' };
}

/** Stable, entropy-free reference token derived from the declaration (audit-friendly). */
function deterministicRef(prefix, declaration = {}) {
    const seed = [
        declaration.reference || '',
        declaration.destination_country || '',
        declaration.customs_value || '',
        (declaration.line_items || []).length,
    ].join('|');
    let h = 0;
    for (let i = 0; i < seed.length; i += 1) {
        h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    }
    return `${prefix}${h.toString().padStart(10, '0').slice(0, 10)}`;
}

module.exports = { decideOutcome, deterministicRef };
