'use strict';
/**
 * CarrierConnector — the BASE INTERFACE every freight-carrier integration extends
 * (War Room 4, Prompt 10).
 *
 * This class owns the carrier-AGNOSTIC quote + booking pipelines + the in-process
 * retry mechanism + failure classification + response normalization. A concrete
 * connector (DHL / FedEx / UPS / Maersk) only supplies the carrier-SPECIFIC steps:
 *
 *   validateRequest(request)              → [{code,level,text}]   carrier lane rules
 *   buildQuoteRequest(request, ctx)       → object                rate API body
 *   transmitQuote(payload, ctx)           → rawRate               the wire call (async)
 *   parseQuote(rawRate, ctx)              → normalizedQuote()
 *   buildBookingRequest(request, quote, ctx) → object             booking API body
 *   transmitBooking(payload, ctx)         → rawBooking            the wire call (async)
 *   parseBooking(rawBooking, ctx)         → normalizedBooking()
 *
 * TWO PIPELINES:
 *   quote(): normalize-aware → validate → build → transmit(+retry) → parse → quote
 *   book():  validate → build → transmit(+retry) → parse → booking
 *
 * The retry here is the IN-PROCESS fast retry for a single transmission burst
 * (a brief carrier-API hiccup). The CARRIER-TO-CARRIER FALLBACK across the whole
 * marketplace lives one layer up in freightGateway.book(): when this connector's
 * retries are exhausted (TRANSIENT) or the carrier rejects (PERMANENT), the gateway
 * moves on to the next-best ranked carrier. Validation failures abort outright.
 *
 * The class is async + side-effect free w.r.t. the database — persistence, the
 * booking lifecycle and recovery live in freightGateway.js.
 */

const {
    CARRIER_PROFILES, FAILURE_KIND, FreightError, isRetryableKind,
    DEFAULT_MAX_ATTEMPTS, DEFAULT_BACKOFF_MS, MODE,
} = require('../schema');
const norm = require('../normalize');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class CarrierConnector {
    /**
     * @param {object} opts
     * @param {string} opts.carrier      one of schema.CARRIER.*
     * @param {string} [opts.carrierName]
     * @param {number} [opts.maxAttempts]
     * @param {number} [opts.backoffMs]
     * @param {function} [opts.onAttempt] (attempt, meta) → void  observability hook
     * @param {function} [opts.sleep]     injectable delay (tests use a no-op)
     */
    constructor(opts = {}) {
        if (new.target === CarrierConnector) {
            throw new Error('CarrierConnector is abstract — extend it with a concrete carrier connector');
        }
        if (!opts.carrier) throw new Error('CarrierConnector requires a carrier');
        this.carrier = opts.carrier;
        const profile = CARRIER_PROFILES[opts.carrier];
        this.profile = profile || null;
        this.carrierName = opts.carrierName || (profile && profile.name) || opts.carrier;
        this.modes = (profile && profile.modes) || [MODE.EXPRESS];
        this.reliability = (profile && profile.reliability) != null ? profile.reliability : 90;
        this.maxAttempts = Math.max(1, Number(opts.maxAttempts) || DEFAULT_MAX_ATTEMPTS);
        this.backoffMs = Math.max(0, Number(opts.backoffMs) || DEFAULT_BACKOFF_MS);
        this.onAttempt = typeof opts.onAttempt === 'function' ? opts.onAttempt : null;
        this._sleep = typeof opts.sleep === 'function' ? opts.sleep : sleep;
    }

    // ── Capability ───────────────────────────────────────────────────────────

    /** Does this carrier serve the requested mode? (null mode ⇒ yes — pick our best). */
    serves(mode) {
        if (!mode) return true;
        return this.modes.includes(mode);
    }

    /** The mode this connector will quote for a request (its preference, or the best it has). */
    resolveMode(request = {}) {
        if (request.mode && this.serves(request.mode)) return request.mode;
        return this.modes[0];
    }

    // ── Abstract steps — concrete connectors MUST override these. ─────────────

    /** Carrier lane / weight validation. @returns {Array<{code,level,text}>} */
    // eslint-disable-next-line no-unused-vars, class-methods-use-this
    validateRequest(request) { throw new Error('validateRequest() not implemented'); }

    /** Project the canonical request into the carrier rate-API body. */
    // eslint-disable-next-line no-unused-vars, class-methods-use-this
    buildQuoteRequest(request, ctx) { throw new Error('buildQuoteRequest() not implemented'); }

    /** Perform the rate wire call. Resolve raw rate, or throw a FreightError. */
    // eslint-disable-next-line no-unused-vars, class-methods-use-this
    async transmitQuote(payload, ctx) { throw new Error('transmitQuote() not implemented'); }

    /** Collapse the raw rate into schema.normalizedQuote(). */
    // eslint-disable-next-line no-unused-vars, class-methods-use-this
    parseQuote(rawRate, ctx) { throw new Error('parseQuote() not implemented'); }

    /** Project the canonical request + chosen quote into the booking-API body. */
    // eslint-disable-next-line no-unused-vars, class-methods-use-this
    buildBookingRequest(request, quote, ctx) { throw new Error('buildBookingRequest() not implemented'); }

    /** Perform the booking wire call. Resolve raw booking, or throw a FreightError. */
    // eslint-disable-next-line no-unused-vars, class-methods-use-this
    async transmitBooking(payload, ctx) { throw new Error('transmitBooking() not implemented'); }

    /** Collapse the raw booking into schema.normalizedBooking(). */
    // eslint-disable-next-line no-unused-vars, class-methods-use-this
    parseBooking(rawBooking, ctx) { throw new Error('parseBooking() not implemented'); }

    // ── Failure helpers for concrete connectors. ──────────────────────────────

    failTransient(message, extra = {}) {
        return new FreightError({ kind: FAILURE_KIND.TRANSIENT, message, carrier: this.carrier, ...extra });
    }

    failPermanent(message, extra = {}) {
        return new FreightError({ kind: FAILURE_KIND.PERMANENT, message, carrier: this.carrier, ...extra });
    }

    failValidation(message, messages = []) {
        return new FreightError({ kind: FAILURE_KIND.VALIDATION, message, carrier: this.carrier, messages });
    }

    /**
     * Map a generic transport error (fetch/timeout/HTTP status) to the right
     * FreightError kind. 408/429/5xx + network aborts are transient; 4xx are
     * permanent carrier rejections.
     */
    classifyTransport(err, { status = null } = {}) {
        if (status != null) {
            if (status === 408 || status === 429 || status >= 500) {
                return this.failTransient(`carrier HTTP ${status}`, { code: `http_${status}`, raw: { status } });
            }
            if (status >= 400) {
                return this.failPermanent(`carrier HTTP ${status}`, { code: `http_${status}`, raw: { status } });
            }
        }
        const name = err && err.name;
        const code = err && err.code;
        const transientNames = ['AbortError', 'FetchError', 'TimeoutError'];
        const transientCodes = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND'];
        if (transientNames.includes(name) || transientCodes.includes(code)) {
            return this.failTransient(err.message || 'transport error', { code: code || name });
        }
        // Unknown errors are treated as transient (safer to retry / fall back than drop).
        return this.failTransient((err && err.message) || 'unknown transport error', { code: err && err.code });
    }

    // ── Quote pipeline ────────────────────────────────────────────────────────

    /**
     * Run the full async QUOTE pipeline for one shipment request.
     * @param {object} requestInput  loose request (normalized internally if needed)
     * @param {object} [ctx]
     * @returns {Promise<{ quote, payload, request, attempts }>}
     * @throws {FreightError} VALIDATION/PERMANENT immediately; TRANSIENT after retries.
     */
    async quote(requestInput, ctx = {}) {
        const request = requestInput && requestInput.__normalized
            ? requestInput
            : Object.assign(norm.normalizeShipmentRequest(requestInput), { __normalized: true });

        const errors = [
            ...norm.baseValidationErrors(request),
            ...(this.validateRequest(request) || []),
        ];
        if (errors.length) {
            throw this.failValidation(
                `request failed ${this.carrierName} validation (${errors.length} issue${errors.length === 1 ? '' : 's'})`,
                errors,
            );
        }

        const mode = this.resolveMode(request);
        const payload = this.buildQuoteRequest(request, { ...ctx, mode, carrier: this.carrier });
        const { rawResponse, attempts } = await this._transmitWithRetry(
            (c) => this.transmitQuote(payload, c), { ...ctx, request, mode, op: 'quote' },
        );
        const quote = this.parseQuote(rawResponse, { ...ctx, request, mode, carrier: this.carrier });
        if (!quote || quote.carrier !== this.carrier) {
            throw this.failTransient('connector returned a non-normalized quote');
        }
        return { quote, payload, request, attempts };
    }

    // ── Booking pipeline ──────────────────────────────────────────────────────

    /**
     * Run the full async BOOKING pipeline against a previously selected quote.
     * @param {object} requestInput  loose / canonical request
     * @param {object} quote         a normalizedQuote (carrier MUST match this connector)
     * @param {object} [ctx]
     * @returns {Promise<{ booking, payload, request, attempts }>}
     */
    async book(requestInput, quote, ctx = {}) {
        const request = requestInput && requestInput.__normalized
            ? requestInput
            : Object.assign(norm.normalizeShipmentRequest(requestInput), { __normalized: true });

        const errors = [
            ...norm.baseValidationErrors(request),
            ...(this.validateRequest(request) || []),
        ];
        if (errors.length) {
            throw this.failValidation(
                `request failed ${this.carrierName} validation (${errors.length} issue${errors.length === 1 ? '' : 's'})`,
                errors,
            );
        }

        const mode = (quote && quote.mode) || this.resolveMode(request);
        const payload = this.buildBookingRequest(request, quote || null, { ...ctx, mode, carrier: this.carrier });
        const { rawResponse, attempts } = await this._transmitWithRetry(
            (c) => this.transmitBooking(payload, c), { ...ctx, request, quote, mode, op: 'book' },
        );
        const booking = this.parseBooking(rawResponse, { ...ctx, request, quote, mode, carrier: this.carrier });
        if (!booking || booking.carrier !== this.carrier) {
            throw this.failTransient('connector returned a non-normalized booking');
        }
        return { booking, payload, request, attempts };
    }

    // ── The retry mechanism (shared by both pipelines). ───────────────────────

    /**
     * Call `fn(ctx)` up to maxAttempts times, sleeping with exponential backoff
     * between attempts, retrying ONLY transient failures. A permanent / validation
     * failure (or a success) exits immediately.
     */
    async _transmitWithRetry(fn, ctx = {}) {
        let lastErr = null;
        for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
            if (this.onAttempt) {
                try { this.onAttempt(attempt, { carrier: this.carrier, op: ctx.op, maxAttempts: this.maxAttempts }); } catch { /* hook never breaks the pipeline */ }
            }
            try {
                const rawResponse = await fn({ ...ctx, attempt, carrier: this.carrier });
                return { rawResponse, attempts: attempt };
            } catch (err) {
                const fe = err instanceof FreightError ? err : this.classifyTransport(err);
                lastErr = fe;
                if (!isRetryableKind(fe.kind) || attempt >= this.maxAttempts) throw fe;
                await this._sleep(this.backoffMs * 2 ** (attempt - 1));
            }
        }
        throw lastErr || this.failTransient('transmission exhausted with no response');
    }
}

module.exports = { CarrierConnector, sleep };
