'use strict';
/**
 * Customs Gateway — DB-backed ORCHESTRATOR (War Room 4, Prompt 9).
 *
 * Wraps the PURE connector layer (the async submission pipeline + in-process retry
 * + response normalization) with the durability the connectors deliberately avoid:
 *
 *   • DB persistence  — every submission is a tracked row in
 *                       tradeops.customs_submissions whose status walks the
 *                       lifecycle (queued → submitting → submitted/accepted/
 *                       rejected/failed). Every attempt + transition appends an
 *                       immutable row to customs_submission_events (the audit).
 *
 *   • Async pipeline  — submit() persists the row and ENQUEUES a durable
 *                       `customs_submission` job; the worker (processSubmission)
 *                       runs the connector pipeline out-of-band. When Redis is
 *                       unavailable the submission is processed INLINE so the API
 *                       still works end-to-end (and the row is recoverable either way).
 *
 *   • Retry (durable) — the connector retries a transient burst IN-PROCESS; the
 *                       BullMQ queue retries the whole job across process restarts
 *                       with exponential backoff. A submission whose retries are
 *                       exhausted lands in `failed` — terminal-but-recoverable.
 *
 *   • Failure recovery — retrySubmission() re-drives a `failed` submission;
 *                       recoverStalled() sweeps in-flight rows that aged out (a
 *                       crashed worker) and re-enqueues them. Both are idempotent
 *                       (jobId = the submission id), so a double-drive can never
 *                       double-file with the gateway.
 *
 * The two retry layers are intentional: the connector handles a brief gateway
 * hiccup fast; the queue + recovery handle a process crash or a long outage.
 */

const db = require('../../models');
const norm = require('./normalize');
const registry = require('./connectors');
const {
    STATUS, FAILURE_KIND, GatewayError, channelForCountry, isTerminal, isRecoverable,
    IN_FLIGHT_STATUSES, ENGINE_VERSION, DEFAULT_MAX_ATTEMPTS,
} = require('./schema');
const { runAs } = require('../../middleware/tenantContext');
const { AppError } = require('../../utils/errors');

const SUBMISSION_QUEUE = 'customs_submission';
const STALLED_AFTER_MS = 10 * 60 * 1000; // 10 minutes in-flight ⇒ presumed stalled

// ── Lazy queue handle (mirrors webhookDispatcher): importing queue/index opens a
// Redis connection, so only resolve it when a submission actually needs enqueuing.
let enqueueFn = null;
let queueResolved = false;
function getEnqueue() {
    if (queueResolved) return enqueueFn;
    queueResolved = true;
    try { enqueueFn = require('../../queue').enqueue; } catch { enqueueFn = null; }
    return enqueueFn;
}

const plain = (x) => (x && typeof x.toJSON === 'function' ? x.toJSON() : x);
const jobId = (submissionId) => `customs:${submissionId}`;

/** Append an immutable lifecycle event (best-effort — never breaks the caller). */
async function appendEvent(submission, { eventType, status, attempt = null, message = null, detail = {}, actor = null }) {
    if (!db.CustomsSubmissionEvent) return null;
    try {
        return await db.CustomsSubmissionEvent.create({
            tenant_id: submission.tenant_id,
            submission_id: submission.id,
            channel: submission.channel,
            event_type: eventType,
            status: status || submission.status,
            attempt,
            message: message ? String(message).slice(0, 1000) : null,
            detail: detail || {},
            created_by: actor || 'system',
        });
    } catch {
        return null; // events table missing / not migrated — degrade
    }
}

/** Normalize a submission row into the stable API view. */
function toView(row) {
    const s = plain(row);
    return {
        id: s.id,
        status: s.status,
        channel: s.channel,
        direction: s.direction,
        origin_country: s.origin_country,
        destination_country: s.destination_country,
        customs_entry_id: s.customs_entry_id,
        shipment_id: s.shipment_id,
        trade_operation_id: s.trade_operation_id,
        attempts: s.attempts,
        max_attempts: s.max_attempts,
        gateway_reference: s.gateway_reference,
        gateway_status: s.gateway_status,
        messages: s.messages || [],
        normalized_response: s.normalized_response || null,
        last_error: s.last_error || null,
        failure_kind: s.failure_kind || null,
        idempotency_key: s.idempotency_key || null,
        engine_version: s.engine_version,
        submitted_at: s.submitted_at || null,
        completed_at: s.completed_at || null,
        created_at: s.created_at || null,
        updated_at: s.updated_at || null,
    };
}

/**
 * Resolve the channel + connector for a submission request. Throws a 422 when the
 * jurisdiction has no connector (an unsupported destination is a client error, not
 * a server fault).
 */
function resolveChannel({ channel, destinationCountry }) {
    const resolved = channel || channelForCountry(destinationCountry);
    if (!resolved) {
        throw new AppError('UNSUPPORTED_JURISDICTION',
            `No customs gateway connector for destination '${destinationCountry || '?'}'`, 422);
    }
    const connector = registry.getConnectorByChannel(resolved);
    if (!connector) {
        throw new AppError('UNSUPPORTED_JURISDICTION', `No connector registered for channel '${resolved}'`, 422);
    }
    return { channel: resolved, connector };
}

/**
 * Create + dispatch a customs submission. The authoritative entry point.
 *
 * @param {object} input
 * @param {object} input.declaration          loose declaration (normalized here)
 * @param {string} [input.channel]            override the country→channel routing
 * @param {string} [input.customsEntryId]     legacy trade.customs_entries ref
 * @param {string} [input.shipmentId]
 * @param {string} [input.tradeOperationId]
 * @param {string} [input.idempotencyKey]     dedupe key (per tenant)
 * @param {string} [input.tenantId]
 * @param {string} [input.actor]
 * @param {number} [input.maxAttempts]
 * @param {boolean} [input.inline]            process synchronously (tests / no-Redis)
 * @returns {Promise<{ record, view }>}
 */
async function submit(input = {}) {
    const declaration = norm.normalizeDeclaration(input.declaration || {});
    const destinationCountry = declaration.destination_country
        || norm.normalizeCountry(input.destinationCountry);
    const { channel } = resolveChannel({ channel: input.channel, destinationCountry });

    const tenantId = input.tenantId || null;

    // Idempotency: an existing non-stale submission for the same key short-circuits.
    if (input.idempotencyKey) {
        const where = { idempotency_key: String(input.idempotencyKey) };
        if (tenantId) where.tenant_id = tenantId;
        const existing = await db.CustomsSubmission.findOne({ where, order: [['created_at', 'DESC']] });
        if (existing && existing.status !== STATUS.FAILED) {
            return { record: existing, view: toView(existing), deduplicated: true };
        }
    }

    const record = await db.CustomsSubmission.create({
        ...(tenantId ? { tenant_id: tenantId } : {}),
        customs_entry_id: input.customsEntryId || null,
        shipment_id: input.shipmentId || null,
        trade_operation_id: input.tradeOperationId || null,
        channel,
        direction: declaration.entry_type,
        origin_country: declaration.origin_country,
        destination_country: destinationCountry,
        declaration,
        status: STATUS.QUEUED,
        attempts: 0,
        max_attempts: Math.max(1, Number(input.maxAttempts) || DEFAULT_MAX_ATTEMPTS),
        idempotency_key: input.idempotencyKey || null,
        engine_version: ENGINE_VERSION,
        created_by: input.actor || null,
    });
    await appendEvent(record, { eventType: 'queued', status: STATUS.QUEUED, actor: input.actor });

    // Dispatch: durable queue when available, else inline so the API still works.
    const enqueue = getEnqueue();
    if (enqueue && !input.inline) {
        try {
            await enqueue(SUBMISSION_QUEUE, 'submit',
                { submissionId: record.id, tenantId: record.tenant_id },
                { jobId: jobId(record.id) });
            return { record, view: toView(record) };
        } catch {
            /* fall through to inline — the row stays recoverable regardless */
        }
    }
    // Inline fallback: run the pipeline now under a synthetic single-attempt job.
    await processSubmission({ data: { submissionId: record.id, tenantId: record.tenant_id }, opts: { attempts: 1 }, attemptsMade: 0 });
    const fresh = await db.CustomsSubmission.findByPk(record.id);
    return { record: fresh, view: toView(fresh) };
}

/**
 * Queue processor body for one submission. Imported by queue/workers.js.
 * Runs OUTSIDE a request, so it executes under an explicit tenant context (the
 * submission's tenant) for RLS + the Sequelize tenant hooks. Throws on a transient
 * failure so BullMQ retries; on the final attempt it lands the row in `failed`.
 */
async function processSubmission(job) {
    const { submissionId, tenantId } = (job && job.data) || {};
    if (!submissionId) return { skipped: true, reason: 'no submissionId' };

    const attemptsAllowed = (job.opts && job.opts.attempts) || 1;
    const finalAttempt = (job.attemptsMade || 0) + 1 >= attemptsAllowed;

    return runAs({ tenantId: tenantId || null, bypass: !tenantId }, async () => {
        const submission = await db.CustomsSubmission.findByPk(submissionId);
        if (!submission) return { skipped: true, reason: 'submission_not_found' };
        // Idempotency: a re-delivered job for an already-finalized submission is a no-op.
        if (isTerminal(submission.status)) {
            return { skipped: true, reason: `already_${submission.status}` };
        }

        const connector = registry.getConnectorByChannel(submission.channel);
        submission.attempts = (submission.attempts || 0) + 1;
        submission.status = STATUS.SUBMITTING;
        if (!submission.submitted_at) submission.submitted_at = new Date();
        await submission.save();
        await appendEvent(submission, { eventType: 'attempt', status: STATUS.SUBMITTING, attempt: submission.attempts });

        if (!connector) {
            return finalizeFailure(submission, new GatewayError({
                kind: FAILURE_KIND.PERMANENT, channel: submission.channel,
                message: `No connector for channel '${submission.channel}'`,
            }), { finalAttempt: true });
        }

        try {
            const { normalized } = await connector.submit(submission.declaration, {
                idempotencyKey: submission.idempotency_key,
            });
            // Success (accepted) OR an async-pending acknowledgement (submitted).
            submission.status = normalized.status;
            submission.gateway_reference = normalized.gateway_reference;
            submission.gateway_status = normalized.gateway_status;
            submission.normalized_response = normalized;
            submission.messages = normalized.messages;
            submission.last_error = null;
            submission.failure_kind = null;
            if (isTerminal(normalized.status)) submission.completed_at = new Date();
            await submission.save();
            await appendEvent(submission, {
                eventType: normalized.status, status: normalized.status, attempt: submission.attempts,
                message: normalized.accepted ? 'accepted by gateway' : `gateway status ${normalized.gateway_status || normalized.status}`,
                detail: { gateway_reference: normalized.gateway_reference, gateway_status: normalized.gateway_status },
            });
            return { submissionId, status: submission.status, accepted: normalized.accepted };
        } catch (err) {
            const ge = err instanceof GatewayError ? err : new GatewayError({ kind: FAILURE_KIND.TRANSIENT, message: String(err && err.message || err) });
            // Validation / permanent ⇒ business rejection, terminal, never retried.
            if (ge.kind === FAILURE_KIND.VALIDATION || ge.kind === FAILURE_KIND.PERMANENT) {
                return finalizeFailure(submission, ge, { rejected: true });
            }
            // Transient ⇒ recoverable. Land in `failed` on the final queue attempt,
            // otherwise re-throw so BullMQ retries the whole job later (durable).
            if (finalAttempt) {
                return finalizeFailure(submission, ge, { finalAttempt: true });
            }
            submission.status = STATUS.SUBMITTED; // keep "in flight" between durable retries
            submission.last_error = String(ge.message).slice(0, 500);
            submission.failure_kind = ge.kind;
            await submission.save();
            await appendEvent(submission, { eventType: 'retry', status: submission.status, attempt: submission.attempts, message: ge.message });
            throw ge; // BullMQ schedules the next attempt with backoff
        }
    });
}

/** Land a submission in its failure resting state (rejected vs failed) + audit. */
async function finalizeFailure(submission, ge, { rejected = false } = {}) {
    const status = rejected ? STATUS.REJECTED : STATUS.FAILED;
    submission.status = status;
    submission.last_error = String(ge.message).slice(0, 500);
    submission.failure_kind = ge.kind;
    if (Array.isArray(ge.messages) && ge.messages.length) submission.messages = ge.messages;
    submission.completed_at = status === STATUS.REJECTED ? new Date() : submission.completed_at;
    await submission.save();
    await appendEvent(submission, {
        eventType: status, status, attempt: submission.attempts, message: ge.message,
        detail: { failure_kind: ge.kind, code: ge.code || null, messages: ge.messages || [] },
    });
    return { submissionId: submission.id, status, failure_kind: ge.kind };
}

// ── Failure recovery ─────────────────────────────────────────────────────────

/**
 * Manually re-drive a `failed` (or stalled) submission. Idempotent via jobId.
 * @returns {Promise<{ record, view }>}
 */
async function retrySubmission(submissionId, { actor = 'system', tenantId = null, force = false } = {}) {
    const where = { id: submissionId };
    if (tenantId) where.tenant_id = tenantId;
    const submission = await db.CustomsSubmission.findOne({ where });
    if (!submission) throw new AppError('NOT_FOUND', 'Customs submission not found', 404);
    if (isTerminal(submission.status) && !(force && submission.status === STATUS.REJECTED)) {
        if (!isRecoverable(submission.status)) {
            throw new AppError('NOT_RETRYABLE', `Submission in status '${submission.status}' cannot be retried`, 409);
        }
    }
    submission.status = STATUS.QUEUED;
    submission.last_error = null;
    submission.failure_kind = null;
    await submission.save();
    await appendEvent(submission, { eventType: 'retry', status: STATUS.QUEUED, message: 'manual retry', actor });

    const enqueue = getEnqueue();
    if (enqueue) {
        try {
            await enqueue(SUBMISSION_QUEUE, 'submit',
                { submissionId: submission.id, tenantId: submission.tenant_id },
                { jobId: `${jobId(submission.id)}:retry:${submission.attempts}` });
            return { record: submission, view: toView(submission) };
        } catch { /* fall through to inline */ }
    }
    await processSubmission({ data: { submissionId: submission.id, tenantId: submission.tenant_id }, opts: { attempts: 1 }, attemptsMade: 0 });
    const fresh = await db.CustomsSubmission.findByPk(submission.id);
    return { record: fresh, view: toView(fresh) };
}

/**
 * Sweep in-flight submissions that have aged past STALLED_AFTER_MS (a crashed
 * worker) and re-enqueue them. Returns the number recovered. Best-effort — a
 * recovery failure for one row never aborts the sweep.
 */
async function recoverStalled({ olderThanMs = STALLED_AFTER_MS, limit = 100, now = new Date() } = {}) {
    if (!db.CustomsSubmission) return { recovered: 0 };
    const cutoff = new Date(now.getTime() - olderThanMs);
    const rows = await db.CustomsSubmission.findAll({
        where: { status: IN_FLIGHT_STATUSES, updated_at: { [db.Sequelize.Op.lt]: cutoff } },
        limit,
        order: [['updated_at', 'ASC']],
    });
    let recovered = 0;
    for (const row of rows) {
        try {
            await appendEvent(row, { eventType: 'recovered', status: row.status, message: 'stalled submission re-enqueued' });
            const enqueue = getEnqueue();
            if (enqueue) {
                await enqueue(SUBMISSION_QUEUE, 'submit',
                    { submissionId: row.id, tenantId: row.tenant_id },
                    { jobId: `${jobId(row.id)}:recover:${row.attempts}` });
            } else {
                await processSubmission({ data: { submissionId: row.id, tenantId: row.tenant_id }, opts: { attempts: 1 }, attemptsMade: 0 });
            }
            recovered += 1;
        } catch { /* best-effort per row */ }
    }
    return { recovered };
}

/** Cancel a non-terminal submission (withdraw before a decision). */
async function cancel(submissionId, { actor = 'system', tenantId = null, reason = null } = {}) {
    const where = { id: submissionId };
    if (tenantId) where.tenant_id = tenantId;
    const submission = await db.CustomsSubmission.findOne({ where });
    if (!submission) throw new AppError('NOT_FOUND', 'Customs submission not found', 404);
    if (isTerminal(submission.status)) {
        throw new AppError('ALREADY_TERMINAL', `Submission already '${submission.status}'`, 409);
    }
    submission.status = STATUS.CANCELLED;
    submission.completed_at = new Date();
    await submission.save();
    await appendEvent(submission, { eventType: 'cancelled', status: STATUS.CANCELLED, message: reason || 'cancelled', actor });
    return { record: submission, view: toView(submission) };
}

// ── Read paths ───────────────────────────────────────────────────────────────

async function getSubmission(submissionId, { tenantId = null } = {}) {
    const where = { id: submissionId };
    if (tenantId) where.tenant_id = tenantId;
    const row = await db.CustomsSubmission.findOne({ where });
    if (!row) throw new AppError('NOT_FOUND', 'Customs submission not found', 404);
    return row;
}

async function listSubmissions({ tenantId = null, status = null, channel = null, shipmentId = null, page = 1, limit = 20 } = {}) {
    const p = Math.max(1, Number.parseInt(page, 10) || 1);
    const l = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));
    const where = {};
    if (tenantId) where.tenant_id = tenantId;
    if (status) where.status = status;
    if (channel) where.channel = channel;
    if (shipmentId) where.shipment_id = shipmentId;
    const { count, rows } = await db.CustomsSubmission.findAndCountAll({
        where, limit: l, offset: (p - 1) * l, order: [['created_at', 'DESC']],
    });
    return { items: rows, total: count, page: p, limit: l, pages: Math.ceil(count / l) || 0 };
}

async function listEvents(submissionId, { tenantId = null, limit = 100 } = {}) {
    if (!db.CustomsSubmissionEvent) return [];
    const where = { submission_id: submissionId };
    if (tenantId) where.tenant_id = tenantId;
    return db.CustomsSubmissionEvent.findAll({
        where, order: [['created_at', 'ASC']], limit: Math.min(500, Math.max(1, Number(limit) || 100)),
    });
}

module.exports = {
    submit,
    processSubmission,
    retrySubmission,
    recoverStalled,
    cancel,
    getSubmission,
    listSubmissions,
    listEvents,
    toView,
    resolveChannel,
    SUBMISSION_QUEUE,
    STALLED_AFTER_MS,
};
