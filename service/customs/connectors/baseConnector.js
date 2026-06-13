'use strict';
/**
 * CustomsConnector — the BASE INTERFACE every government-gateway connector
 * extends (War Room 4, Prompt 9).
 *
 * This class owns the country-AGNOSTIC submission pipeline + retry + failure
 * classification + response normalization. A concrete connector (ICEGATE / ACE /
 * CDS / Mirsal) only supplies the four country-SPECIFIC steps:
 *
 *   validateDeclaration(declaration)  → [{code,level,text}]   jurisdiction rules
 *   buildPayload(declaration, ctx)    → object                gateway message body
 *   transmit(payload, ctx)            → rawResponse           the wire call (async)
 *   parseResponse(rawResponse, ctx)   → normalizedResponse()  collapse to one shape
 *
 * THE PIPELINE — `submit()`:
 *   1. normalize     the declaration to the canonical form (shared)
 *   2. validate      base completeness + the connector's jurisdiction rules.
 *                    Any error → throw a VALIDATION GatewayError (never retried).
 *   3. build         the gateway-specific payload.
 *   4. transmit      with the RETRY MECHANISM: bounded attempts with exponential
 *                    backoff, retrying ONLY transient failures. Permanent /
 *                    validation failures short-circuit immediately.
 *   5. parse         the raw response into the normalized shape.
 *
 * The whole thing is async and side-effect free w.r.t. the database — persistence,
 * durable queue retries and recovery live one layer up in customsGateway.js. This
 * connector's retry is the IN-PROCESS fast retry for a single transmission burst;
 * the gateway's queue is the DURABLE retry across process restarts.
 */

const {
    STATUS, FAILURE_KIND, GatewayError, normalizedResponse,
    DEFAULT_MAX_ATTEMPTS, DEFAULT_BACKOFF_MS, isRetryableKind,
} = require('../schema');
const norm = require('../normalize');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class CustomsConnector {
    /**
     * @param {object} opts
     * @param {string} opts.channel      one of schema.CHANNEL.*
     * @param {string} [opts.gatewayName] human label (for messages/audit)
     * @param {number} [opts.maxAttempts]
     * @param {number} [opts.backoffMs]
     * @param {function} [opts.onAttempt] (attempt, meta) → void  observability hook
     * @param {function} [opts.sleep]     injectable delay (tests use a no-op)
     */
    constructor(opts = {}) {
        if (new.target === CustomsConnector) {
            throw new Error('CustomsConnector is abstract — extend it with a concrete gateway connector');
        }
        if (!opts.channel) throw new Error('CustomsConnector requires a channel');
        this.channel = opts.channel;
        this.gatewayName = opts.gatewayName || opts.channel;
        this.maxAttempts = Math.max(1, Number(opts.maxAttempts) || DEFAULT_MAX_ATTEMPTS);
        this.backoffMs = Math.max(0, Number(opts.backoffMs) || DEFAULT_BACKOFF_MS);
        this.onAttempt = typeof opts.onAttempt === 'function' ? opts.onAttempt : null;
        this._sleep = typeof opts.sleep === 'function' ? opts.sleep : sleep;
    }

    // ── Abstract steps — concrete connectors MUST override these. ────────────

    /** Jurisdiction-specific validation. @returns {Array<{code,level,text}>} */
    // eslint-disable-next-line no-unused-vars, class-methods-use-this
    validateDeclaration(declaration) {
        throw new Error('validateDeclaration() not implemented');
    }

    /** Project the canonical declaration into the gateway message body. */
    // eslint-disable-next-line no-unused-vars, class-methods-use-this
    buildPayload(declaration, ctx) {
        throw new Error('buildPayload() not implemented');
    }

    /**
     * Perform the actual wire transmission. MUST resolve with the raw gateway
     * response, or throw a GatewayError (use the failTransient / failPermanent /
     * classifyTransport helpers) so the pipeline can decide whether to retry.
     */
    // eslint-disable-next-line no-unused-vars, class-methods-use-this
    async transmit(payload, ctx) {
        throw new Error('transmit() not implemented');
    }

    /** Collapse the raw gateway response into schema.normalizedResponse(). */
    // eslint-disable-next-line no-unused-vars, class-methods-use-this
    parseResponse(rawResponse, ctx) {
        throw new Error('parseResponse() not implemented');
    }

    // ── Failure helpers for concrete connectors. ─────────────────────────────

    failTransient(message, extra = {}) {
        return new GatewayError({ kind: FAILURE_KIND.TRANSIENT, message, channel: this.channel, ...extra });
    }

    failPermanent(message, extra = {}) {
        return new GatewayError({ kind: FAILURE_KIND.PERMANENT, message, channel: this.channel, ...extra });
    }

    failValidation(message, messages = []) {
        return new GatewayError({ kind: FAILURE_KIND.VALIDATION, message, channel: this.channel, messages });
    }

    /**
     * Map a generic transport error (fetch/timeout/HTTP status) to the right
     * GatewayError kind. 408/429/5xx + network aborts are transient; 4xx are
     * permanent business rejections. Concrete `transmit()` implementations that
     * use real HTTP should funnel their errors through this.
     */
    classifyTransport(err, { status = null } = {}) {
        if (status != null) {
            if (status === 408 || status === 429 || status >= 500) {
                return this.failTransient(`gateway HTTP ${status}`, { code: `http_${status}`, raw: { status } });
            }
            if (status >= 400) {
                return this.failPermanent(`gateway HTTP ${status}`, { code: `http_${status}`, raw: { status } });
            }
        }
        const name = err && err.name;
        const transientNames = ['AbortError', 'FetchError', 'TimeoutError'];
        const code = err && err.code;
        const transientCodes = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND'];
        if (transientNames.includes(name) || transientCodes.includes(code)) {
            return this.failTransient(err.message || 'transport error', { code: code || name });
        }
        // Unknown errors are treated as transient (safer to retry than to drop a filing).
        return this.failTransient((err && err.message) || 'unknown transport error', { code: err && err.code });
    }

    // ── The submission pipeline. ─────────────────────────────────────────────

    /**
     * Run the full async submission pipeline for one declaration.
     *
     * @param {object} declarationInput  loose declaration (normalized internally)
     * @param {object} [ctx]             { idempotencyKey, attemptOffset, signal }
     * @returns {Promise<{ normalized, payload, declaration, attempts }>}
     * @throws {GatewayError}            VALIDATION / PERMANENT immediately;
     *                                   TRANSIENT only after exhausting retries.
     */
    async submit(declarationInput, ctx = {}) {
        const declaration = norm.normalizeDeclaration(declarationInput);

        // 2. Validate (base + jurisdiction). Validation failures are never retried.
        const errors = [
            ...norm.baseValidationErrors(declaration),
            ...(this.validateDeclaration(declaration) || []),
        ];
        if (errors.length) {
            throw this.failValidation(
                `declaration failed ${this.gatewayName} validation (${errors.length} issue${errors.length === 1 ? '' : 's'})`,
                errors,
            );
        }

        // 3. Build the gateway payload.
        const payload = this.buildPayload(declaration, { ...ctx, channel: this.channel });

        // 4. Transmit with the retry mechanism.
        const { rawResponse, attempts } = await this._transmitWithRetry(payload, { ...ctx, declaration });

        // 5. Normalize the response.
        const normalized = this.parseResponse(rawResponse, { ...ctx, declaration, channel: this.channel });
        if (!normalized || normalized.channel !== this.channel) {
            throw this.failTransient('connector returned a non-normalized response');
        }
        return { normalized, payload, declaration, attempts };
    }

    /**
     * The RETRY MECHANISM. Calls transmit() up to maxAttempts times, sleeping with
     * exponential backoff between attempts, and ONLY retries transient failures.
     * A permanent / validation failure (or a successful response) exits immediately.
     */
    async _transmitWithRetry(payload, ctx = {}) {
        let lastErr = null;
        for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
            if (this.onAttempt) {
                try { this.onAttempt(attempt, { channel: this.channel, maxAttempts: this.maxAttempts }); } catch { /* hook never breaks the pipeline */ }
            }
            try {
                const rawResponse = await this.transmit(payload, { ...ctx, attempt, channel: this.channel });
                return { rawResponse, attempts: attempt };
            } catch (err) {
                const ge = err instanceof GatewayError ? err : this.classifyTransport(err);
                lastErr = ge;
                // Non-retryable, or last attempt → propagate.
                if (!isRetryableKind(ge.kind) || attempt >= this.maxAttempts) throw ge;
                // Exponential backoff before the next attempt.
                await this._sleep(this.backoffMs * 2 ** (attempt - 1));
            }
        }
        // Unreachable (loop either returns or throws), but keep the contract explicit.
        throw lastErr || this.failTransient('transmission exhausted with no response');
    }

    /**
     * One-shot helper a connector's parseResponse can use to emit the normalized
     * shape for THIS channel without repeating the channel/received_at plumbing.
     */
    normalize(fields = {}) {
        return normalizedResponse({
            channel: this.channel,
            received_at: fields.received_at || new Date().toISOString(),
            ...fields,
        });
    }

    /** Expose the status vocabulary so connectors don't re-import schema. */
    // eslint-disable-next-line class-methods-use-this
    get STATUS() { return STATUS; }
}

module.exports = { CustomsConnector, sleep };
