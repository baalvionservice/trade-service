'use strict';
/**
 * Freight Gateway — DB-backed ORCHESTRATOR (War Room 4, Prompt 10).
 *
 * Wraps the PURE carrier layer (connectors + the quote comparison engine) with the
 * persistence + lifecycle the connectors deliberately avoid:
 *
 *   • Quote     — quote() runs the comparison engine across every eligible carrier
 *                 and returns the ranked marketplace (no commitment, no DB write).
 *
 *   • Booking workflow — book() persists a tradeops.freight_bookings row whose status
 *                 walks the lifecycle (booking → booked/failed → confirmed →
 *                 in_transit → delivered/cancelled). Every attempt + transition
 *                 appends an immutable row to freight_booking_events (the audit).
 *
 *   • FALLBACK LOGIC — the headline. book() tries carriers in ranked order; if the
 *                 chosen carrier's retries are exhausted (TRANSIENT) or it rejects
 *                 the lane (PERMANENT), the workflow AUTOMATICALLY falls back to the
 *                 next-best carrier — up to maxFallbacks — and only lands in `failed`
 *                 when every candidate is exhausted. A VALIDATION failure aborts
 *                 immediately (every carrier would reject the same bad request).
 *
 *   • Recovery  — retryBooking() re-drives a `failed` booking with fresh quotes;
 *                 recoverStalled() sweeps rows stuck in `booking` (a crash mid-book)
 *                 and re-drives them. Both are idempotent via the idempotency key.
 *
 * The connector's in-process retry handles a brief single-carrier hiccup; this layer's
 * carrier-to-carrier fallback handles a carrier being down or refusing the lane. The
 * two are complementary — fast retry first, then switch carriers.
 */

const db = require('../../models');
const norm = require('./normalize');
const engine = require('./quoteEngine');
const registry = require('./connectors');
const {
    STATUS, FAILURE_KIND, FreightError, isTerminal, isRecoverable, isFallbackKind,
    IN_FLIGHT_STATUSES, ENGINE_VERSION, DEFAULT_MAX_FALLBACKS,
} = require('./schema');
const { runAs } = require('../../middleware/tenantContext');
const { AppError } = require('../../utils/errors');

const STALLED_AFTER_MS = 10 * 60 * 1000; // 10 minutes in `booking` ⇒ presumed stalled

const plain = (x) => (x && typeof x.toJSON === 'function' ? x.toJSON() : x);

/** Append an immutable lifecycle event (best-effort — never breaks the caller). */
async function appendEvent(booking, { eventType, status, carrier = null, attempt = null, message = null, detail = {}, actor = null }) {
    if (!db.FreightBookingEvent) return null;
    try {
        return await db.FreightBookingEvent.create({
            tenant_id: booking.tenant_id,
            booking_id: booking.id,
            carrier: carrier || booking.carrier || null,
            event_type: eventType,
            status: status || booking.status,
            attempt,
            message: message ? String(message).slice(0, 1000) : null,
            detail: detail || {},
            created_by: actor || 'system',
        });
    } catch {
        return null; // events table missing / not migrated — degrade gracefully
    }
}

/** Normalize a booking row into the stable API view. */
function toView(row) {
    const b = plain(row);
    return {
        id: b.id,
        status: b.status,
        carrier: b.carrier,
        service_level: b.service_level,
        mode: b.mode,
        origin: b.origin,
        destination: b.destination,
        order_id: b.order_id,
        shipment_id: b.shipment_id,
        trade_operation_id: b.trade_operation_id,
        chargeable_weight_kg: b.chargeable_weight_kg != null ? Number(b.chargeable_weight_kg) : null,
        amount: b.amount != null ? Number(b.amount) : null,
        currency: b.currency,
        tracking_number: b.tracking_number,
        gateway_reference: b.gateway_reference,
        label_url: b.label_url,
        estimated_delivery: b.estimated_delivery,
        selected_quote: b.selected_quote || null,
        quotes: b.quotes || [],
        carriers_attempted: b.carriers_attempted || [],
        attempts: b.attempts,
        messages: b.messages || [],
        last_error: b.last_error || null,
        failure_kind: b.failure_kind || null,
        idempotency_key: b.idempotency_key || null,
        engine_version: b.engine_version,
        booked_at: b.booked_at || null,
        completed_at: b.completed_at || null,
        created_at: b.created_at || null,
        updated_at: b.updated_at || null,
    };
}

// ── Quote (no commitment) ─────────────────────────────────────────────────────

/**
 * Run the marketplace comparison for a request. Pure pass-through to the engine
 * (no DB write); the controller persists nothing until the buyer books.
 */
async function quote(input = {}) {
    return engine.compareQuotes(input.request || input, {
        rank: input.rank,
        weights: input.weights,
        ttlHours: input.ttlHours,
        now: input.now,
    });
}

// ── Booking workflow + fallback ───────────────────────────────────────────────

/**
 * Build the ordered list of { connector, quote } candidates to attempt, honoring a
 * preferred carrier (booked first) then the ranked fallbacks.
 */
function buildCandidates(comparison, { preferredCarrier = null, maxFallbacks = DEFAULT_MAX_FALLBACKS } = {}) {
    const ranked = comparison.ranked || [];
    let ordered = ranked;
    if (preferredCarrier) {
        const chosen = ranked.filter((q) => q.carrier === preferredCarrier);
        const rest = ranked.filter((q) => q.carrier !== preferredCarrier);
        ordered = [...chosen, ...rest];
    }
    return ordered
        .slice(0, Math.max(1, maxFallbacks + 1)) // primary + up to N fallbacks
        .map((q) => ({ connector: registry.getConnectorByCarrier(q.carrier), quote: q }))
        .filter((c) => c.connector);
}

/**
 * Create + drive a freight booking through the carrier-fallback workflow.
 *
 * @param {object} input
 * @param {object} input.request           loose shipment request (normalized here)
 * @param {string} [input.preferredCarrier] book this carrier first; fall back on failure
 * @param {object} [input.comparison]      a pre-computed engine result (skips re-quote)
 * @param {number} [input.maxFallbacks]    cap on carriers tried after the first
 * @param {string} [input.orderId]
 * @param {string} [input.shipmentId]
 * @param {string} [input.tradeOperationId]
 * @param {string} [input.idempotencyKey]
 * @param {string} [input.tenantId]
 * @param {string} [input.actor]
 * @param {Date}   [input.now]
 * @returns {Promise<{ record, view, deduplicated? }>}
 */
async function book(input = {}) {
    const request = Object.assign(norm.normalizeShipmentRequest(input.request || input), { __normalized: true });
    const tenantId = input.tenantId || null;

    // Idempotency: an existing non-failed booking for the same key short-circuits.
    if (input.idempotencyKey) {
        const where = { idempotency_key: String(input.idempotencyKey) };
        if (tenantId) where.tenant_id = tenantId;
        const existing = await db.FreightBooking.findOne({ where, order: [['created_at', 'DESC']] });
        if (existing && existing.status !== STATUS.FAILED) {
            return { record: existing, view: toView(existing), deduplicated: true };
        }
    }

    // Gather (or reuse) the ranked marketplace.
    const comparison = input.comparison && input.comparison.ranked
        ? input.comparison
        : await engine.compareQuotes(request, { now: input.now, weights: input.weights });

    const candidates = buildCandidates(comparison, {
        preferredCarrier: input.preferredCarrier || null,
        maxFallbacks: input.maxFallbacks != null ? Number(input.maxFallbacks) : DEFAULT_MAX_FALLBACKS,
    });

    const record = await db.FreightBooking.create({
        ...(tenantId ? { tenant_id: tenantId } : {}),
        order_id: input.orderId || null,
        shipment_id: input.shipmentId || null,
        trade_operation_id: input.tradeOperationId || null,
        mode: request.mode || (comparison.best && comparison.best.mode) || null,
        status: STATUS.BOOKING,
        origin: request.origin || {},
        destination: request.destination || {},
        request,
        quotes: comparison.ranked || [],
        chargeable_weight_kg: request.chargeable_weight_kg || null,
        currency: request.currency || 'USD',
        carriers_attempted: [],
        attempts: 0,
        max_fallbacks: input.maxFallbacks != null ? Number(input.maxFallbacks) : DEFAULT_MAX_FALLBACKS,
        idempotency_key: input.idempotencyKey || null,
        engine_version: ENGINE_VERSION,
        created_by: input.actor || null,
    });
    await appendEvent(record, { eventType: 'quoted', status: STATUS.BOOKING, message: `${comparison.ranked.length} carrier quote(s); ${candidates.length} candidate(s)`, detail: { carriers_quoted: comparison.carriers_quoted, carriers_failed: comparison.carriers_failed } });

    if (candidates.length === 0) {
        return finalizeFailure(record, new FreightError({
            kind: FAILURE_KIND.PERMANENT,
            message: comparison.errors.length ? 'no carrier could quote this shipment' : 'no eligible carrier for this shipment',
            messages: comparison.errors.flatMap((e) => e.messages || []),
        }), { request });
    }

    return driveBooking(record, request, candidates, { actor: input.actor });
}

/**
 * The fallback loop: attempt each candidate carrier in order; first acceptance wins.
 * A fallback-eligible failure (transient exhausted / permanent rejection) advances to
 * the next carrier; a validation failure aborts.
 */
async function driveBooking(record, request, candidates, { actor = 'system' } = {}) {
    const attempted = [];
    let lastError = null;

    for (let i = 0; i < candidates.length; i += 1) {
        const { connector, quote } = candidates[i];
        record.attempts = (record.attempts || 0) + 1;
        attempted.push(connector.carrier);
        await appendEvent(record, {
            eventType: 'attempt', status: STATUS.BOOKING, carrier: connector.carrier, attempt: record.attempts,
            message: i === 0 ? `booking primary carrier ${connector.carrier}` : `falling back to ${connector.carrier} (candidate ${i + 1}/${candidates.length})`,
        });

        try {
            const { booking } = await connector.book(request, quote, { actor });
            if (!booking.accepted && booking.status === STATUS.FAILED) {
                // Carrier responded but didn't confirm → treat as a fallback-eligible failure.
                throw new FreightError({ kind: FAILURE_KIND.PERMANENT, carrier: connector.carrier, message: 'carrier did not confirm the booking', messages: booking.messages });
            }
            return finalizeSuccess(record, booking, quote, { attempted, actor });
        } catch (err) {
            const fe = err instanceof FreightError ? err : new FreightError({ kind: FAILURE_KIND.TRANSIENT, carrier: connector.carrier, message: String(err && err.message || err) });
            lastError = fe;

            // VALIDATION ⇒ the request itself is bad; no carrier will accept it. Abort.
            if (fe.kind === FAILURE_KIND.VALIDATION) {
                record.carriers_attempted = attempted;
                return finalizeFailure(record, fe, { request, rejected: true });
            }
            // Fallback-eligible ⇒ record + continue to the next candidate.
            await appendEvent(record, {
                eventType: 'fallback', status: STATUS.BOOKING, carrier: connector.carrier, attempt: record.attempts,
                message: `${connector.carrier} failed (${fe.kind}): ${fe.message}`,
                detail: { failure_kind: fe.kind, code: fe.code || null },
            });
            if (!isFallbackKind(fe.kind)) break; // unknown kind — stop rather than loop blindly
        }
    }

    // Every candidate exhausted.
    record.carriers_attempted = attempted;
    return finalizeFailure(record, lastError || new FreightError({ kind: FAILURE_KIND.TRANSIENT, message: 'all carriers failed' }), { request });
}

/** Land a booking as BOOKED + persist the winning carrier/quote/tracking + audit. */
async function finalizeSuccess(record, booking, quote, { attempted = [], actor = 'system' } = {}) {
    record.status = STATUS.BOOKED;
    record.carrier = booking.carrier;
    record.service_level = booking.service_level || (quote && quote.service_level) || null;
    record.mode = booking.mode || (quote && quote.mode) || record.mode;
    record.amount = booking.amount != null ? booking.amount : (quote && quote.amount) || null;
    record.currency = booking.currency || record.currency;
    record.tracking_number = booking.tracking_number;
    record.gateway_reference = booking.gateway_reference;
    record.label_url = booking.label_url;
    record.estimated_delivery = booking.estimated_delivery || (quote && quote.estimated_delivery) || null;
    record.selected_quote = quote || null;
    record.carriers_attempted = attempted;
    record.messages = booking.messages || [];
    record.last_error = null;
    record.failure_kind = null;
    record.booked_at = new Date();
    await record.save();
    await appendEvent(record, {
        eventType: 'booked', status: STATUS.BOOKED, carrier: booking.carrier, attempt: record.attempts,
        message: `booked with ${booking.carrier} (${record.tracking_number})`,
        detail: { tracking_number: record.tracking_number, amount: record.amount, currency: record.currency, fell_back: attempted.length > 1 },
        actor,
    });
    return { record, view: toView(record) };
}

/** Land a booking in `failed` (every carrier exhausted) + audit. */
async function finalizeFailure(record, fe, { rejected = false } = {}) {
    record.status = STATUS.FAILED;
    record.last_error = String(fe.message).slice(0, 500);
    record.failure_kind = fe.kind;
    if (Array.isArray(fe.messages) && fe.messages.length) record.messages = fe.messages;
    await record.save();
    await appendEvent(record, {
        eventType: 'failed', status: STATUS.FAILED, attempt: record.attempts, message: fe.message,
        detail: { failure_kind: fe.kind, rejected, carriers_attempted: record.carriers_attempted || [] },
    });
    return { record, view: toView(record) };
}

// ── Lifecycle transitions (tracking) ──────────────────────────────────────────

const FORWARD = {
    [STATUS.BOOKED]: [STATUS.CONFIRMED, STATUS.IN_TRANSIT, STATUS.CANCELLED],
    [STATUS.CONFIRMED]: [STATUS.IN_TRANSIT, STATUS.CANCELLED],
    [STATUS.IN_TRANSIT]: [STATUS.DELIVERED],
};

/** Advance a booking's status (carrier webhook / manual tracking update). */
async function updateStatus(bookingId, nextStatus, { actor = 'system', tenantId = null, detail = {} } = {}) {
    const booking = await getBooking(bookingId, { tenantId });
    const allowed = FORWARD[booking.status] || [];
    if (!allowed.includes(nextStatus)) {
        throw new AppError('INVALID_TRANSITION', `Cannot move booking from '${booking.status}' to '${nextStatus}'`, 409);
    }
    booking.status = nextStatus;
    if (isTerminal(nextStatus)) booking.completed_at = new Date();
    await booking.save();
    await appendEvent(booking, { eventType: nextStatus, status: nextStatus, message: `status → ${nextStatus}`, detail, actor });
    return { record: booking, view: toView(booking) };
}

// ── Recovery ──────────────────────────────────────────────────────────────────

/** Re-drive a `failed` booking with a fresh marketplace comparison. Idempotent. */
async function retryBooking(bookingId, { actor = 'system', tenantId = null, now = null } = {}) {
    const booking = await getBooking(bookingId, { tenantId });
    if (!isRecoverable(booking.status)) {
        throw new AppError('NOT_RETRYABLE', `Booking in status '${booking.status}' cannot be retried`, 409);
    }
    const request = Object.assign({ ...booking.request }, { __normalized: true });
    const comparison = await engine.compareQuotes(request, { now });
    const candidates = buildCandidates(comparison, { maxFallbacks: booking.max_fallbacks != null ? booking.max_fallbacks : DEFAULT_MAX_FALLBACKS });

    booking.status = STATUS.BOOKING;
    booking.quotes = comparison.ranked || [];
    booking.last_error = null;
    booking.failure_kind = null;
    await booking.save();
    await appendEvent(booking, { eventType: 'retry', status: STATUS.BOOKING, message: 'manual retry — re-quoted marketplace', actor });

    if (candidates.length === 0) {
        return finalizeFailure(booking, new FreightError({ kind: FAILURE_KIND.PERMANENT, message: 'no carrier available on retry' }), { request });
    }
    return driveBooking(booking, request, candidates, { actor });
}

/**
 * Sweep bookings stuck in `booking` past STALLED_AFTER_MS (a crash mid-book) and
 * re-drive them. Returns the number recovered. Best-effort per row.
 */
async function recoverStalled({ olderThanMs = STALLED_AFTER_MS, limit = 100, now = new Date() } = {}) {
    if (!db.FreightBooking) return { recovered: 0 };
    const cutoff = new Date(now.getTime() - olderThanMs);
    const rows = await db.FreightBooking.findAll({
        where: { status: IN_FLIGHT_STATUSES, updated_at: { [db.Sequelize.Op.lt]: cutoff } },
        limit, order: [['updated_at', 'ASC']],
    });
    let recovered = 0;
    for (const row of rows) {
        try {
            await runAs({ tenantId: row.tenant_id || null, bypass: !row.tenant_id }, async () => {
                const request = Object.assign({ ...row.request }, { __normalized: true });
                const comparison = await engine.compareQuotes(request);
                const candidates = buildCandidates(comparison, { maxFallbacks: row.max_fallbacks != null ? row.max_fallbacks : DEFAULT_MAX_FALLBACKS });
                row.quotes = comparison.ranked || [];
                await row.save();
                await appendEvent(row, { eventType: 'recovered', status: STATUS.BOOKING, message: 'stalled booking re-driven' });
                if (candidates.length) await driveBooking(row, request, candidates, { actor: 'system' });
                else await finalizeFailure(row, new FreightError({ kind: FAILURE_KIND.PERMANENT, message: 'no carrier available on recovery' }), { request });
            });
            recovered += 1;
        } catch { /* best-effort per row */ }
    }
    return { recovered };
}

/** Cancel a non-terminal booking. */
async function cancel(bookingId, { actor = 'system', tenantId = null, reason = null } = {}) {
    const booking = await getBooking(bookingId, { tenantId });
    if (isTerminal(booking.status)) {
        throw new AppError('ALREADY_TERMINAL', `Booking already '${booking.status}'`, 409);
    }
    booking.status = STATUS.CANCELLED;
    booking.completed_at = new Date();
    await booking.save();
    await appendEvent(booking, { eventType: 'cancelled', status: STATUS.CANCELLED, message: reason || 'cancelled', actor });
    return { record: booking, view: toView(booking) };
}

// ── Read paths ────────────────────────────────────────────────────────────────

async function getBooking(bookingId, { tenantId = null } = {}) {
    const where = { id: bookingId };
    if (tenantId) where.tenant_id = tenantId;
    const row = await db.FreightBooking.findOne({ where });
    if (!row) throw new AppError('NOT_FOUND', 'Freight booking not found', 404);
    return row;
}

async function listBookings({ tenantId = null, status = null, carrier = null, shipmentId = null, orderId = null, page = 1, limit = 20 } = {}) {
    const p = Math.max(1, Number.parseInt(page, 10) || 1);
    const l = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));
    const where = {};
    if (tenantId) where.tenant_id = tenantId;
    if (status) where.status = status;
    if (carrier) where.carrier = carrier;
    if (shipmentId) where.shipment_id = shipmentId;
    if (orderId) where.order_id = orderId;
    const { count, rows } = await db.FreightBooking.findAndCountAll({
        where, limit: l, offset: (p - 1) * l, order: [['created_at', 'DESC']],
    });
    return { items: rows, total: count, page: p, limit: l, pages: Math.ceil(count / l) || 0 };
}

async function listEvents(bookingId, { tenantId = null, limit = 200 } = {}) {
    if (!db.FreightBookingEvent) return [];
    const where = { booking_id: bookingId };
    if (tenantId) where.tenant_id = tenantId;
    return db.FreightBookingEvent.findAll({
        where, order: [['created_at', 'ASC']], limit: Math.min(500, Math.max(1, Number(limit) || 200)),
    });
}

module.exports = {
    quote,
    book,
    driveBooking,
    buildCandidates,
    updateStatus,
    retryBooking,
    recoverStalled,
    cancel,
    getBooking,
    listBookings,
    listEvents,
    toView,
    STALLED_AFTER_MS,
};
