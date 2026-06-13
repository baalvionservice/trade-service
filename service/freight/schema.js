'use strict';
/**
 * Freight Marketplace Integration Layer — VOCABULARY + FACTORIES (War Room 4, Prompt 10).
 *
 * PURE: no DB, no I/O, no network. Defines the single stable vocabulary every
 * carrier connector + the quote engine + the booking gateway speak — the booking
 * STATUS ladder, the carrier CARRIERs (one per integration: DHL / FedEx / UPS /
 * Maersk), the transport MODE taxonomy, the FAILURE_KIND taxonomy that drives the
 * retry + fallback decisions, and the `normalizedQuote()` / `normalizedBooking()` /
 * `freightError()` factories every connector funnels through so a rate quote and a
 * booking are shape-identical regardless of WHICH carrier produced them.
 *
 * Each integrated carrier returns a wildly different rate/booking payload (DHL's
 * MyDHL API, FedEx's Ship API, UPS's RaaS, Maersk's Ocean/Booking API) — this module
 * is where they collapse to one shape so the marketplace can compare apples to apples.
 *
 * A NORMALIZED QUOTE — the single shape the comparison engine ranks, regardless of
 * which carrier produced it:
 *   {
 *     carrier:           CARRIER.*        — the carrier that quoted
 *     service_level:     string           — the carrier's product (e.g. 'EXPRESS_WORLDWIDE')
 *     mode:              MODE.*           — express / air / ocean / road
 *     amount:            number           — total quoted price (minor-unit-safe number)
 *     currency:          string
 *     transit_days:      number           — door-to-door business days
 *     estimated_delivery:ISO string|null  — computed by the ETA engine
 *     valid_until:       ISO string|null  — quote expiry
 *     surcharges:        [{ code, label, amount }]
 *     reliability:       number 0-100     — historical on-time performance
 *     chargeable_weight: number           — the weight the price was computed on
 *     raw:               object           — untouched carrier payload (audit)
 *   }
 *
 * A NORMALIZED BOOKING — the single shape the booking workflow persists:
 *   {
 *     carrier, status, accepted, tracking_number, gateway_reference,
 *     label_url, service_level, mode, amount, currency, estimated_delivery,
 *     messages:[{code,level,text}], retryable, received_at, raw
 *   }
 */

// ── Booking status ladder. Order = lifecycle progression. ────────────────────
const STATUS = Object.freeze({
    DRAFT: 'draft',           // quote(s) gathered, no carrier committed yet
    BOOKING: 'booking',       // a booking attempt is in flight (across fallback carriers)
    BOOKED: 'booked',         // a carrier accepted the booking (has a tracking number)
    CONFIRMED: 'confirmed',   // carrier confirmed pickup / label issued
    IN_TRANSIT: 'in_transit', // goods picked up, moving
    DELIVERED: 'delivered',   // terminal +
    CANCELLED: 'cancelled',   // withdrawn (terminal)
    FAILED: 'failed',         // no carrier could be booked after fallback (recoverable)
});

// Terminal states never auto-transition again. `failed` is terminal-but-recoverable:
// the resting place after every fallback carrier was exhausted, and the input to
// retryBooking / recoverStalled.
const TERMINAL_STATUSES = Object.freeze(['delivered', 'cancelled']);
const RECOVERABLE_STATUSES = Object.freeze(['failed']);
// In-flight states a recovery sweep treats as "stalled" once they age out (a worker
// that crashed mid-book leaves a row stuck in `booking`).
const IN_FLIGHT_STATUSES = Object.freeze(['booking']);

const isTerminal = (status) => TERMINAL_STATUSES.includes(status);
const isRecoverable = (status) => RECOVERABLE_STATUSES.includes(status);

// ── Carriers — one per marketplace integration. ──────────────────────────────
const CARRIER = Object.freeze({
    DHL: 'dhl',         // DHL Express / Global Forwarding (MyDHL API)
    FEDEX: 'fedex',     // FedEx Express / Freight (FedEx Ship API)
    UPS: 'ups',         // UPS (Rating & Shipping APIs)
    MAERSK: 'maersk',   // Maersk Line (Ocean booking + rates API)
});

const VALID_CARRIERS = Object.freeze(Object.values(CARRIER));

// ── Transport modes. ─────────────────────────────────────────────────────────
const MODE = Object.freeze({
    EXPRESS: 'express', // time-definite door-to-door parcel/express
    AIR: 'air',         // air freight
    OCEAN: 'ocean',     // sea / container freight
    ROAD: 'road',       // ground / road haulage
});

const VALID_MODES = Object.freeze(Object.values(MODE));

/**
 * Carrier capability profiles — which modes each integration can serve + its
 * baseline reliability + display name. The quote engine uses `modes` to decide
 * which carriers are ELIGIBLE for a given shipment (an ocean-only request never
 * goes to an express-only carrier, and vice-versa).
 */
const CARRIER_PROFILES = Object.freeze({
    [CARRIER.DHL]: Object.freeze({
        carrier: CARRIER.DHL,
        name: 'DHL',
        modes: Object.freeze([MODE.EXPRESS, MODE.AIR, MODE.ROAD]),
        reliability: 97,
        default_currency: 'USD',
    }),
    [CARRIER.FEDEX]: Object.freeze({
        carrier: CARRIER.FEDEX,
        name: 'FedEx',
        modes: Object.freeze([MODE.EXPRESS, MODE.AIR, MODE.ROAD]),
        reliability: 96,
        default_currency: 'USD',
    }),
    [CARRIER.UPS]: Object.freeze({
        carrier: CARRIER.UPS,
        name: 'UPS',
        modes: Object.freeze([MODE.EXPRESS, MODE.AIR, MODE.ROAD]),
        reliability: 95,
        default_currency: 'USD',
    }),
    [CARRIER.MAERSK]: Object.freeze({
        carrier: CARRIER.MAERSK,
        name: 'Maersk Line',
        modes: Object.freeze([MODE.OCEAN, MODE.ROAD]),
        reliability: 93,
        default_currency: 'USD',
    }),
});

/** Carriers that can serve a given mode (null mode ⇒ every carrier is eligible). */
function carriersForMode(mode) {
    if (!mode) return [...VALID_CARRIERS];
    return VALID_CARRIERS.filter((c) => CARRIER_PROFILES[c].modes.includes(mode));
}

// ── Failure taxonomy. Drives the retry (base connector) + the fallback (gateway)
//    decisions. ──────────────────────────────────────────────────────────────
const FAILURE_KIND = Object.freeze({
    // Local request validation failed BEFORE any carrier call. Never retried; never
    // worth falling back (every carrier would reject the same bad request).
    VALIDATION: 'validation',
    // The carrier (or transport) failed in a way that may succeed on a retry:
    // timeout, connection reset, 5xx, rate-limit. Retried in-process; on exhaustion
    // the gateway falls back to the next-best carrier.
    TRANSIENT: 'transient',
    // The carrier answered with a definitive rejection for THIS carrier (lane not
    // served, embargo, account limit). No retry — but DO fall back to another carrier.
    PERMANENT: 'permanent',
});

const RETRYABLE_KINDS = Object.freeze([FAILURE_KIND.TRANSIENT]);
const isRetryableKind = (kind) => RETRYABLE_KINDS.includes(kind);
// A failure that should trigger carrier-to-carrier fallback (vs. abort the booking).
const FALLBACK_KINDS = Object.freeze([FAILURE_KIND.TRANSIENT, FAILURE_KIND.PERMANENT]);
const isFallbackKind = (kind) => FALLBACK_KINDS.includes(kind);

// ── Normalized message levels. ───────────────────────────────────────────────
const MESSAGE_LEVEL = Object.freeze({ INFO: 'info', WARNING: 'warning', ERROR: 'error' });

// ── Ranking strategies the comparison engine exposes. ────────────────────────
const RANK = Object.freeze({
    CHEAPEST: 'cheapest', // lowest amount first
    FASTEST: 'fastest',   // fewest transit days first
    BEST: 'best',         // composite price + speed + reliability score
});
const VALID_RANKS = Object.freeze(Object.values(RANK));

// Default composite-score weights for RANK.BEST. Tunable without code changes via
// quoteEngine options. Sum need not be 1 — the score is relative within a request.
const DEFAULT_RANK_WEIGHTS = Object.freeze({ price: 0.5, speed: 0.3, reliability: 0.2 });

// ── Engine version (stamped on every booking for audit / replay safety). ─────
const ENGINE_VERSION = 'freight-marketplace@1.0.0';

// Default retry budget for a single carrier connector pipeline (in-process burst).
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 400;
// How long a quote is valid by default.
const DEFAULT_QUOTE_TTL_HOURS = 48;
// Default cap on how many carriers the booking workflow will try before giving up.
const DEFAULT_MAX_FALLBACKS = 3;

/** Coerce + bound a normalized message. */
function message(m = {}) {
    const { code = null, level = MESSAGE_LEVEL.INFO, text = '' } = m;
    return Object.freeze({
        code: code != null ? String(code) : null,
        level: Object.values(MESSAGE_LEVEL).includes(level) ? level : MESSAGE_LEVEL.INFO,
        text: String(text || '').slice(0, 1000),
    });
}

/** Coerce to a finite non-negative number (0 on garbage). */
function num(v) {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Coerce + bound a single surcharge line. */
function surcharge(s = {}) {
    return Object.freeze({
        code: s.code != null ? String(s.code) : null,
        label: String(s.label || s.code || 'surcharge').slice(0, 120),
        amount: num(s.amount),
    });
}

/**
 * Build a NORMALIZED QUOTE — the single choke-point every connector's `parseQuote()`
 * funnels through so the comparison engine never sees a raw, carrier-specific rate.
 * @returns {object} a frozen normalized quote
 */
function normalizedQuote(q = {}) {
    const {
        carrier,
        service_level = null,
        mode = MODE.EXPRESS,
        amount = 0,
        currency = 'USD',
        transit_days = 0,
        estimated_delivery = null,
        valid_until = null,
        surcharges = [],
        reliability = null,
        chargeable_weight = 0,
        raw = {},
    } = q;

    if (!VALID_CARRIERS.includes(carrier)) {
        throw new Error(`normalizedQuote(): unknown carrier '${carrier}'`);
    }
    if (!VALID_MODES.includes(mode)) {
        throw new Error(`normalizedQuote(): unknown mode '${mode}'`);
    }

    return Object.freeze({
        carrier,
        service_level: service_level != null ? String(service_level) : null,
        mode,
        amount: num(amount),
        currency: String(currency || 'USD').toUpperCase().slice(0, 8),
        transit_days: Math.max(0, Math.round(num(transit_days))),
        estimated_delivery: estimated_delivery || null,
        valid_until: valid_until || null,
        surcharges: Object.freeze((Array.isArray(surcharges) ? surcharges : []).map(surcharge)),
        reliability: reliability != null ? Math.max(0, Math.min(100, Math.round(num(reliability)))) : null,
        chargeable_weight: num(chargeable_weight),
        raw: raw && typeof raw === 'object' ? raw : {},
    });
}

/**
 * Build a NORMALIZED BOOKING response — what a connector's `parseBooking()` returns
 * so the booking workflow persists one shape no matter which carrier confirmed.
 * @returns {object} a frozen normalized booking
 */
function normalizedBooking(b = {}) {
    const {
        carrier,
        status = STATUS.BOOKED,
        accepted = false,
        tracking_number = null,
        gateway_reference = null,
        label_url = null,
        service_level = null,
        mode = MODE.EXPRESS,
        amount = 0,
        currency = 'USD',
        estimated_delivery = null,
        messages = [],
        retryable = false,
        received_at = null,
        raw = {},
    } = b;

    if (!VALID_CARRIERS.includes(carrier)) {
        throw new Error(`normalizedBooking(): unknown carrier '${carrier}'`);
    }
    if (!Object.values(STATUS).includes(status)) {
        throw new Error(`normalizedBooking(): unknown status '${status}'`);
    }

    return Object.freeze({
        carrier,
        status,
        accepted: !!accepted,
        tracking_number: tracking_number != null ? String(tracking_number) : null,
        gateway_reference: gateway_reference != null ? String(gateway_reference) : null,
        label_url: label_url != null ? String(label_url) : null,
        service_level: service_level != null ? String(service_level) : null,
        mode: VALID_MODES.includes(mode) ? mode : MODE.EXPRESS,
        amount: num(amount),
        currency: String(currency || 'USD').toUpperCase().slice(0, 8),
        estimated_delivery: estimated_delivery || null,
        messages: Object.freeze((Array.isArray(messages) ? messages : []).map(message)),
        retryable: !!retryable,
        received_at: received_at || null,
        raw: raw && typeof raw === 'object' ? raw : {},
    });
}

/**
 * A structured carrier error — what a connector throws when a quote/booking attempt
 * fails. `kind` decides whether the base pipeline retries (TRANSIENT), and whether
 * the booking gateway falls back to another carrier (TRANSIENT | PERMANENT) or
 * aborts (VALIDATION). Always carry the carrier + any messages for the audit.
 */
class FreightError extends Error {
    constructor({ kind, message: msg, carrier = null, code = null, messages = [], raw = null } = {}) {
        super(msg || `freight carrier ${kind || 'error'}`);
        this.name = 'FreightError';
        this.kind = Object.values(FAILURE_KIND).includes(kind) ? kind : FAILURE_KIND.TRANSIENT;
        this.carrier = carrier;
        this.code = code != null ? String(code) : null;
        this.messages = (Array.isArray(messages) ? messages : []).map(message);
        this.raw = raw;
        this.retryable = isRetryableKind(this.kind);
    }
}

/** Convenience factory mirroring the customs gatewayError factory style. */
function freightError(kind, msg, extra = {}) {
    return new FreightError({ kind, message: msg, ...extra });
}

module.exports = {
    STATUS,
    TERMINAL_STATUSES,
    RECOVERABLE_STATUSES,
    IN_FLIGHT_STATUSES,
    isTerminal,
    isRecoverable,
    CARRIER,
    VALID_CARRIERS,
    MODE,
    VALID_MODES,
    CARRIER_PROFILES,
    carriersForMode,
    FAILURE_KIND,
    RETRYABLE_KINDS,
    isRetryableKind,
    FALLBACK_KINDS,
    isFallbackKind,
    MESSAGE_LEVEL,
    RANK,
    VALID_RANKS,
    DEFAULT_RANK_WEIGHTS,
    ENGINE_VERSION,
    DEFAULT_MAX_ATTEMPTS,
    DEFAULT_BACKOFF_MS,
    DEFAULT_QUOTE_TTL_HOURS,
    DEFAULT_MAX_FALLBACKS,
    message,
    num,
    surcharge,
    normalizedQuote,
    normalizedBooking,
    FreightError,
    freightError,
};
