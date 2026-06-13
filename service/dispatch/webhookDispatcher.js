'use strict';
/**
 * Dispatch Orchestration Engine — webhook fan-out (War Room 4, Prompt 11).
 *
 * Enqueues one job per (lifecycle event × subscription) onto the BullMQ
 * `dispatch_webhook` queue, which provides bounded retries, exponential backoff
 * and a dead-letter queue (queue/index.js + queue/workers.js). The matching
 * processor performs the signed HTTPS POST and advances the persisted delivery
 * row (pending → delivered / failed).
 *
 * Enqueue is BEST-EFFORT and post-commit: if Redis is unavailable the delivery
 * row stays `pending` and is recoverable — the transaction that changed dispatch
 * state has already committed durably. Mirrors service/workflow/webhookDispatcher.
 */
const crypto = require('crypto');
const db = require('../../models');

let enqueueFn = null;
let queueResolved = false;
function getEnqueue() {
    if (queueResolved) return enqueueFn;
    queueResolved = true;
    try { enqueueFn = require('../../queue').enqueue; } catch { enqueueFn = null; }
    return enqueueFn;
}

const WEBHOOK_QUEUE = 'dispatch_webhook';

/** HMAC-SHA256 over the exact JSON bytes, matching the worker's verification. */
function sign(secret, body) {
    return crypto.createHmac('sha256', secret || 'baalvion').update(body).digest('hex');
}

/**
 * Enqueue a batch of delivery descriptors produced by the engine.
 * @param {Array<{deliveryId,tenantId,url,secret,payload}>} deliveries
 */
async function enqueueDeliveries(deliveries = []) {
    const enqueue = getEnqueue();
    if (!enqueue || !deliveries.length) return { enqueued: 0 };
    let enqueued = 0;
    for (const d of deliveries) {
        try {
            // jobId = deliveryId → dedupe so a double-enqueue cannot double-deliver.
            await enqueue(WEBHOOK_QUEUE, 'deliver', {
                deliveryId: d.deliveryId,
                tenantId: d.tenantId,
                url: d.url,
                secret: d.secret,
                payload: d.payload,
            }, { jobId: `dspwh:${d.deliveryId}` });
            enqueued += 1;
        } catch {
            /* leave the row pending for replay; never throw into the caller */
        }
    }
    return { enqueued };
}

// --- SSRF guard (mirrors queue/workers.js): block private / loopback / link-local ---
const PRIVATE = [/^127\./, /^10\./, /^192\.168\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^::1$/, /^localhost$/i, /^0\.0\.0\.0$/];
function assertPublicHttps(url) {
    const u = new URL(url);
    if (u.protocol !== 'https:') throw new Error('webhook_insecure_protocol');
    if (PRIVATE.some((re) => re.test(u.hostname))) throw new Error(`webhook_blocked_host:${u.hostname}`);
}

/**
 * Queue processor body for a single delivery. Imported by queue/workers.js.
 * Performs the signed POST and advances the delivery row. Throws on failure so
 * BullMQ retries; on the final attempt the row is marked failed.
 */
async function processDelivery(job) {
    const { deliveryId, url, secret, payload } = job.data || {};
    const attemptsAllowed = (job.opts && job.opts.attempts) || 1;
    const finalAttempt = (job.attemptsMade || 0) + 1 >= attemptsAllowed;

    const delivery = deliveryId && db.DispatchWebhookDelivery
        ? await db.DispatchWebhookDelivery.findByPk(deliveryId)
        : null;

    try {
        assertPublicHttps(url);
        const body = JSON.stringify(payload || {});
        const sig = sign(secret, body);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        let res;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Baalvion-Signature': sig,
                    'X-Baalvion-Event': (payload && payload.type) || 'dispatch.event',
                    'X-Baalvion-Delivery': String(deliveryId || ''),
                },
                body,
                signal: controller.signal,
            });
        } finally { clearTimeout(timer); }

        if (delivery) {
            delivery.attempts = (delivery.attempts || 0) + 1;
            delivery.last_status_code = res.status;
        }
        if (!res.ok) {
            if (delivery) {
                delivery.last_error = `http_${res.status}`;
                if (finalAttempt) delivery.status = 'failed';
                await delivery.save();
            }
            throw new Error(`webhook_http_${res.status}`);
        }
        if (delivery) {
            delivery.status = 'delivered';
            delivery.last_error = null;
            delivery.delivered_at = new Date();
            await delivery.save();
        }
        return { status: res.status, deliveryId };
    } catch (err) {
        if (delivery && delivery.status !== 'delivered') {
            delivery.attempts = (delivery.attempts || 0) + 1;
            delivery.last_error = String((err && err.message) || err).slice(0, 500);
            if (finalAttempt) delivery.status = 'failed';
            try { await delivery.save(); } catch { /* best-effort */ }
        }
        throw err;
    }
}

module.exports = { enqueueDeliveries, processDelivery, sign, assertPublicHttps, WEBHOOK_QUEUE };
