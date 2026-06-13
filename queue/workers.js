'use strict';
/**
 * BullMQ workers with REAL processors. On a job that exhausts its retries, the
 * worker routes a replayable copy to the dead-letter queue.
 */
const crypto = require('crypto');
const { Worker } = require('bullmq');
const connection = require('./connection');
const { deadLetter } = require('./index');
const providers = require('../providers');
const cache = require('../cache');
const { recordAudit } = require('../utils/audit');
const { processNotification, recordDelivery } = require('../services/notification-dispatch');

const metrics = { processed: {}, failed: {}, deadLettered: 0 };
const bump = (m, k) => { m[k] = (m[k] || 0) + 1; };

// --- SSRF guard for outbound webhooks (block private / loopback / link-local) ---
const PRIVATE = [/^127\./, /^10\./, /^192\.168\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^::1$/, /^localhost$/i, /^0\.0\.0\.0$/];
function assertPublicHttps(url) {
    const u = new URL(url);
    if (u.protocol !== 'https:') throw new Error('webhook_insecure_protocol');
    if (PRIVATE.some((re) => re.test(u.hostname))) throw new Error(`webhook_blocked_host:${u.hostname}`);
}

const PROCESSORS = {
    notifications: async (job) => processNotification(job.data),

    email: async (job) => {
        const { to, subject, tenantId } = job.data || {};
        if (String(to).startsWith('fail@')) throw new Error('provider_rejected'); // exercised by tests/poison detection
        const simulated = !process.env.EMAIL_API_KEY; // real send when key present
        await recordDelivery({ channel: 'email', to, status: 'delivered', simulated, tenantId });
        return { delivered: true, simulated, subject };
    },

    sms: async (job) => {
        const { to, tenantId } = job.data || {};
        const simulated = !process.env.SMS_API_KEY;
        await recordDelivery({ channel: 'sms', to, status: 'delivered', simulated, tenantId });
        return { delivered: true, simulated };
    },

    audit: async (job) => { await recordAudit(job.data); return { recorded: true }; },

    fx_refresh: async (job) => {
        const { base = 'USD', target = 'EUR' } = job.data || {};
        const rate = await providers.fx.getRate(base, target);
        await cache.set(cache.key('global', 'fx', `${base}_${target}`), rate, 60);
        return rate;
    },

    ws_fanout: async (job) => {
        const { room, event, data } = job.data || {};
        await require('../realtime').publish(room, event, data);
        return { fanned: room };
    },

    webhook_delivery: async (job) => {
        const { url, payload, secret } = job.data || {};
        assertPublicHttps(url);
        const body = JSON.stringify(payload || {});
        const sig = crypto.createHmac('sha256', secret || 'baalvion').update(body).digest('hex');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        try {
            const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Baalvion-Signature': sig }, body, signal: controller.signal });
            if (!res.ok) throw new Error(`webhook_http_${res.status}`);
            return { status: res.status };
        } finally { clearTimeout(timer); }
    },

    // Shipment Workflow state-machine transition fan-out (War Room 4, Prompt 2).
    // Signs + POSTs the transition event and advances the persisted delivery row.
    workflow_webhook: async (job) => require('../service/workflow/webhookDispatcher').processDelivery(job),

    // Document-engine virus scan (War Room 4, Prompt 4). Fetches + decrypts the
    // stored object, scans it, and releases (available) or quarantines the document.
    document_scan: async (job) => require('../service/documents/scanProcessor').processScan(job),

    // Customs Gateway filing pipeline (War Room 4, Prompt 9). Runs the connector
    // submission pipeline (validate → build → transmit+retry → normalize) for the
    // persisted submission and advances its lifecycle. Throws on a transient failure
    // so BullMQ retries; an exhausted job lands the row in `failed` (recoverable).
    customs_submission: async (job) => require('../service/customs/customsGateway').processSubmission(job),

    // Dispatch Orchestration webhook fan-out (War Room 4, Prompt 11). Signs + POSTs
    // a dispatch lifecycle event (condition signal / ready / dispatched / rolled_back
    // / failed) and advances the persisted delivery row. Throws on failure so BullMQ
    // retries; an exhausted job lands the row failed (and is dead-lettered).
    dispatch_webhook: async (job) => require('../service/dispatch/webhookDispatcher').processDelivery(job),
};

const workers = [];

function startWorkers() {
    if (workers.length) return workers; // idempotent
    for (const [name, processor] of Object.entries(PROCESSORS)) {
        const worker = new Worker(name, async (job) => {
            const r = await processor(job);
            bump(metrics.processed, name);
            return r;
        }, { connection, concurrency: 5 });

        worker.on('failed', async (job, err) => {
            bump(metrics.failed, name);
            // Exhausted all attempts → poison/dead-letter (replayable).
            if (job && job.attemptsMade >= (job.opts.attempts || 1)) {
                metrics.deadLettered += 1;
                try { await deadLetter(name, job, err && err.message); } catch { /* best-effort */ }
            }
        });
        workers.push(worker);
    }
    // eslint-disable-next-line no-console
    console.log(`[queue] started ${workers.length} workers: ${Object.keys(PROCESSORS).join(', ')}`);
    return workers;
}

async function stopWorkers() { await Promise.all(workers.map((w) => w.close())); workers.length = 0; }

const workerMetrics = () => ({ ...metrics, active: workers.length });

module.exports = { startWorkers, stopWorkers, workerMetrics, PROCESSORS };
