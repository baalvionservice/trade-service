'use strict';
/**
 * BullMQ queue registry. Every job is persisted in Redis with bounded retries +
 * exponential backoff; jobs that exhaust retries are routed to a dead-letter
 * queue (replayable). Dedup/idempotency via jobId.
 */
const { Queue } = require('bullmq');
const connection = require('./connection');

const QUEUE_NAMES = [
    'notifications', 'email', 'sms', 'audit', 'analytics', 'fx_refresh',
    'ocr', 'ai', 'shipment_sync', 'webhook_delivery', 'ws_fanout',
    'workflow_webhook', // shipment workflow state-machine transition fan-out
    'document_scan',    // document-engine virus scan → release/quarantine (Prompt 4)
    'customs_submission', // customs gateway filing pipeline → ICEGATE/ACE/CDS/Mirsal (Prompt 9)
    'dispatch_webhook',   // dispatch orchestration lifecycle webhook fan-out (Prompt 11)
];
const DLQ = 'dead-letter';

const DEFAULT_JOB_OPTS = {
    attempts: 3,
    backoff: { type: 'exponential', delay: 500 },
    removeOnComplete: 500,   // keep recent for metrics, then trim
    removeOnFail: false,     // keep failed for inspection; DLQ holds the replayable copy
};

const queues = {};
const q = (name) => {
    if (!queues[name]) queues[name] = new Queue(name, { connection, defaultJobOptions: DEFAULT_JOB_OPTS });
    return queues[name];
};
[...QUEUE_NAMES, DLQ].forEach(q); // pre-create

// Enqueue a persisted job. opts.jobId enables dedup/idempotency.
const enqueue = (name, jobName, data, opts = {}) => q(name).add(jobName, data, opts);

// Route an exhausted job to the dead-letter queue with full replay context.
const deadLetter = (originalQueue, job, reason) => q(DLQ).add('dead', {
    originalQueue,
    jobName: job.name,
    data: job.data,
    reason: String(reason || 'unknown'),
    originalId: job.id,
    failedAt: new Date().toISOString(),
}, { removeOnComplete: false });

async function health() {
    const out = {};
    for (const n of [...QUEUE_NAMES, DLQ]) {
        // counts across all states
        out[n] = await q(n).getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused');
    }
    return out;
}

// Replay dead-letter jobs back onto their original queues (admin recovery).
async function replayDeadLetter(limit = 100) {
    const dlq = q(DLQ);
    const jobs = await dlq.getJobs(['waiting', 'active', 'completed', 'failed', 'delayed'], 0, limit);
    let replayed = 0;
    for (const job of jobs) {
        const { originalQueue, jobName, data } = job.data || {};
        if (!originalQueue) continue;
        await enqueue(originalQueue, jobName || 'replay', data);
        await job.remove();
        replayed += 1;
    }
    return replayed;
}

const pause = (name) => q(name).pause();
const resume = (name) => q(name).resume();

module.exports = { q, enqueue, deadLetter, health, replayDeadLetter, pause, resume, QUEUE_NAMES, DLQ, connection };
