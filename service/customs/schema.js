'use strict';
/**
 * Customs Gateway Abstraction Layer — VOCABULARY + FACTORIES (War Room 4, Prompt 9).
 *
 * PURE: no DB, no I/O, no network. Defines the single stable vocabulary every
 * connector + the gateway speak — the submission STATUS ladder, the connector
 * CHANNELs (one per government system), the FAILURE_KIND taxonomy that drives the
 * retry decision, and the `submission()` / `normalizedResponse()` / `gatewayError()`
 * factories every producer funnels through so a submission + a normalized gateway
 * response are shape-identical regardless of WHICH connector (ICEGATE / ACE / CDS /
 * Mirsal) raised them. Country-specific gateways return wildly different raw
 * payloads — this module is where they collapse to one shape.
 *
 * A NORMALIZED RESPONSE is the single shape the rest of the platform consumes,
 * no matter which gateway produced it:
 *   {
 *     channel:           CHANNEL.*            — the gateway that answered
 *     status:            STATUS.*             — mapped from the gateway's own codes
 *     accepted:          boolean              — terminal positive acknowledgement
 *     gateway_reference: string|null          — the gov reference (BE no / entry no)
 *     gateway_status:    string|null          — the gateway's NATIVE status code
 *     messages:          [{ code, level, text }]  — normalized gateway messages
 *     retryable:         boolean              — gateway says "try again" (transient)
 *     received_at:       ISO string
 *     raw:               object               — the untouched gateway payload (audit)
 *   }
 */

// ── Submission status ladder. Order = lifecycle progression. ─────────────────
const STATUS = Object.freeze({
    DRAFT: 'draft',           // created, not yet handed to a gateway
    QUEUED: 'queued',         // enqueued for transmission (durable)
    SUBMITTING: 'submitting', // a transmission attempt is in flight
    SUBMITTED: 'submitted',   // transmitted; awaiting an async gateway decision
    ACCEPTED: 'accepted',     // gateway accepted / registered / cleared (terminal +)
    REJECTED: 'rejected',     // gateway rejected on business grounds (terminal −)
    FAILED: 'failed',         // transmission failed after exhausting retries (recoverable)
    CANCELLED: 'cancelled',   // withdrawn before a terminal decision (terminal)
});

// Terminal states never auto-transition again. `failed` is terminal-but-recoverable:
// it is the resting place after retries are exhausted and is the input to manual /
// swept recovery (retrySubmission / recoverStalled).
const TERMINAL_STATUSES = Object.freeze(['accepted', 'rejected', 'cancelled']);
const RECOVERABLE_STATUSES = Object.freeze(['failed']);
// In-flight states a recovery sweep treats as "stalled" once they age out.
const IN_FLIGHT_STATUSES = Object.freeze(['queued', 'submitting', 'submitted']);

const isTerminal = (status) => TERMINAL_STATUSES.includes(status);
const isRecoverable = (status) => RECOVERABLE_STATUSES.includes(status);

// ── Connector channels — one per government gateway. ─────────────────────────
const CHANNEL = Object.freeze({
    ICEGATE: 'icegate',   // India — CBIC ICEGATE (Bill of Entry / Shipping Bill)
    ACE: 'ace',           // United States — CBP ACE (Automated Commercial Environment)
    EU_CDS: 'eu_cds',     // European Union — UCC Customs Declaration System / ICS2
    UAE_MIRSAL: 'mirsal', // United Arab Emirates — Dubai Customs Mirsal 2
});

const VALID_CHANNELS = Object.freeze(Object.values(CHANNEL));

// ── Failure taxonomy. Drives the retry decision in the base connector. ───────
const FAILURE_KIND = Object.freeze({
    // Local declaration validation failed BEFORE any transmission. Never retried —
    // the declaration must be corrected and resubmitted.
    VALIDATION: 'validation',
    // The gateway (or transport) failed in a way that may succeed on a retry:
    // timeout, connection reset, 5xx, rate-limit, gateway maintenance window.
    TRANSIENT: 'transient',
    // The gateway answered with a definitive business rejection (bad HS code,
    // licence missing, duplicate entry). Retrying the same payload is futile.
    PERMANENT: 'permanent',
});

const RETRYABLE_KINDS = Object.freeze([FAILURE_KIND.TRANSIENT]);
const isRetryableKind = (kind) => RETRYABLE_KINDS.includes(kind);

// ── Normalized message levels. ───────────────────────────────────────────────
const MESSAGE_LEVEL = Object.freeze({ INFO: 'info', WARNING: 'warning', ERROR: 'error' });

// ── Country → channel routing. ISO-3166 alpha-2 (and EU member states). ──────
const EU_MEMBER_STATES = Object.freeze([
    'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU',
    'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]);

const COUNTRY_CHANNEL = Object.freeze({
    IN: CHANNEL.ICEGATE,
    US: CHANNEL.ACE,
    AE: CHANNEL.UAE_MIRSAL,
    ...Object.fromEntries(EU_MEMBER_STATES.map((c) => [c, CHANNEL.EU_CDS])),
});

/** Resolve the gateway channel for an ISO-2 jurisdiction (null when unsupported). */
function channelForCountry(iso2) {
    if (!iso2) return null;
    return COUNTRY_CHANNEL[String(iso2).trim().toUpperCase()] || null;
}

// ── Engine version (stamped on every submission for audit / replay safety). ──
const ENGINE_VERSION = 'customs-gateway@1.0.0';

// Default retry budget for a single connector submission pipeline.
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 500;

const VALID_DIRECTIONS = Object.freeze(['import', 'export']);

/** Coerce + bound a normalized message. */
function message(m = {}) {
    const { code = null, level = MESSAGE_LEVEL.INFO, text = '' } = m;
    return Object.freeze({
        code: code != null ? String(code) : null,
        level: Object.values(MESSAGE_LEVEL).includes(level) ? level : MESSAGE_LEVEL.INFO,
        text: String(text || '').slice(0, 1000),
    });
}

/**
 * Build a NORMALIZED gateway response — the single choke-point every connector's
 * `parseResponse()` funnels through so downstream code never sees a raw, gateway-
 * specific payload.
 * @returns {object} a frozen normalized response
 */
function normalizedResponse(r = {}) {
    const {
        channel,
        status = STATUS.SUBMITTED,
        accepted = false,
        gateway_reference = null,
        gateway_status = null,
        messages = [],
        retryable = false,
        received_at = null,
        raw = {},
    } = r;

    if (!VALID_CHANNELS.includes(channel)) {
        throw new Error(`normalizedResponse(): unknown channel '${channel}'`);
    }
    if (!Object.values(STATUS).includes(status)) {
        throw new Error(`normalizedResponse(): unknown status '${status}'`);
    }

    return Object.freeze({
        channel,
        status,
        accepted: !!accepted,
        gateway_reference: gateway_reference != null ? String(gateway_reference) : null,
        gateway_status: gateway_status != null ? String(gateway_status) : null,
        messages: Object.freeze((Array.isArray(messages) ? messages : []).map(message)),
        retryable: !!retryable,
        received_at: received_at || null,
        raw: raw && typeof raw === 'object' ? raw : {},
    });
}

/**
 * A structured gateway error — what a connector throws when a submission attempt
 * fails. `kind` decides whether the base pipeline retries (TRANSIENT) or gives up
 * (VALIDATION / PERMANENT). Always carry the channel + any messages for the audit.
 */
class GatewayError extends Error {
    constructor({ kind, message: msg, channel = null, code = null, messages = [], raw = null } = {}) {
        super(msg || `customs gateway ${kind || 'error'}`);
        this.name = 'GatewayError';
        this.kind = Object.values(FAILURE_KIND).includes(kind) ? kind : FAILURE_KIND.TRANSIENT;
        this.channel = channel;
        this.code = code != null ? String(code) : null;
        this.messages = (Array.isArray(messages) ? messages : []).map(message);
        this.raw = raw;
        this.retryable = isRetryableKind(this.kind);
    }
}

/** Convenience factory mirroring the AppError / suggestion factory style. */
function gatewayError(kind, msg, extra = {}) {
    return new GatewayError({ kind, message: msg, ...extra });
}

/**
 * Build a normalized SUBMISSION descriptor — the in-memory shape the gateway
 * persists. Not frozen (the gateway mutates status across the lifecycle), but the
 * factory guarantees every required field is present + typed.
 */
function submission(s = {}) {
    const {
        tenant_id = null,
        customs_entry_id = null,
        shipment_id = null,
        trade_operation_id = null,
        channel,
        direction = 'import',
        origin_country = null,
        destination_country = null,
        declaration = {},
        status = STATUS.DRAFT,
        idempotency_key = null,
    } = s;

    if (!VALID_CHANNELS.includes(channel)) {
        throw new Error(`submission(): unknown channel '${channel}'`);
    }

    return {
        tenant_id: tenant_id != null ? String(tenant_id) : null,
        customs_entry_id: customs_entry_id != null ? String(customs_entry_id) : null,
        shipment_id: shipment_id != null ? String(shipment_id) : null,
        trade_operation_id: trade_operation_id != null ? String(trade_operation_id) : null,
        channel,
        direction: VALID_DIRECTIONS.includes(direction) ? direction : 'import',
        origin_country: origin_country || null,
        destination_country: destination_country || null,
        declaration: declaration && typeof declaration === 'object' ? declaration : {},
        status: Object.values(STATUS).includes(status) ? status : STATUS.DRAFT,
        idempotency_key: idempotency_key || null,
    };
}

module.exports = {
    STATUS,
    TERMINAL_STATUSES,
    RECOVERABLE_STATUSES,
    IN_FLIGHT_STATUSES,
    isTerminal,
    isRecoverable,
    CHANNEL,
    VALID_CHANNELS,
    FAILURE_KIND,
    RETRYABLE_KINDS,
    isRetryableKind,
    MESSAGE_LEVEL,
    EU_MEMBER_STATES,
    COUNTRY_CHANNEL,
    channelForCountry,
    ENGINE_VERSION,
    DEFAULT_MAX_ATTEMPTS,
    DEFAULT_BACKOFF_MS,
    VALID_DIRECTIONS,
    message,
    normalizedResponse,
    GatewayError,
    gatewayError,
    submission,
};
