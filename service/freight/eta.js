'use strict';
/**
 * Freight Marketplace Integration Layer — PURE ETA calculation engine (Prompt 10).
 *
 * No DB, no I/O. Turns a carrier's quoted transit time (business days) plus a ready
 * date into concrete pickup + delivery estimates the whole marketplace consumes.
 * Deterministic: given the same inputs it always returns the same dates, so the
 * comparison engine's ranking and the verify harness are reproducible.
 *
 * The model is intentionally simple but realistic:
 *   • transit is counted in BUSINESS DAYS — weekends are skipped (carriers don't
 *     count Sat/Sun toward time-definite commitments).
 *   • a same-day-cutoff pickup: if the ready date itself is a business day the
 *     carrier picks up that day; otherwise pickup rolls to the next business day.
 *   • door-to-door = pickup date + N business days transit.
 *
 * Holidays are out of scope (they're carrier + lane + year specific); the engine
 * exposes an injectable `isBusinessDay` so a caller could layer a holiday calendar
 * without changing this module.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Default business-day test: Mon–Fri (UTC). 0 = Sunday, 6 = Saturday. */
function defaultIsBusinessDay(date) {
    const dow = date.getUTCDay();
    return dow !== 0 && dow !== 6;
}

/** Parse a loose date input into a Date (null when unparseable). */
function toDate(value) {
    if (value == null) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

/** Strip a Date to a UTC midnight (date-only) instant. */
function atUtcMidnight(date) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Advance to the next business day if the given date is not one. */
function rollToBusinessDay(date, isBusinessDay) {
    let d = atUtcMidnight(date);
    while (!isBusinessDay(d)) d = new Date(d.getTime() + DAY_MS);
    return d;
}

/** Add N business days to a date (N=0 returns the same day if it's a business day). */
function addBusinessDays(start, days, isBusinessDay) {
    let d = atUtcMidnight(start);
    let remaining = Math.max(0, Math.round(days));
    while (remaining > 0) {
        d = new Date(d.getTime() + DAY_MS);
        if (isBusinessDay(d)) remaining -= 1;
    }
    return d;
}

/**
 * Estimate pickup + delivery for a quote.
 *
 * @param {object} opts
 * @param {number} opts.transitDays      door-to-door business days (carrier quote)
 * @param {string|Date} [opts.readyDate] when the shipment is ready (defaults to now)
 * @param {Date}   [opts.now]            injectable clock (tests pass a fixed instant)
 * @param {function} [opts.isBusinessDay]
 * @returns {{ transit_days, ready_date, estimated_pickup, estimated_delivery }}
 *          ISO date strings (date-only, UTC).
 */
function estimateEta({ transitDays, readyDate = null, now = null, isBusinessDay = defaultIsBusinessDay } = {}) {
    const transit = Math.max(0, Math.round(Number(transitDays) || 0));
    const base = toDate(readyDate) || toDate(now) || new Date();
    const ready = atUtcMidnight(base);
    const pickup = rollToBusinessDay(ready, isBusinessDay);
    const delivery = addBusinessDays(pickup, transit, isBusinessDay);
    const iso = (d) => d.toISOString().slice(0, 10);
    return {
        transit_days: transit,
        ready_date: iso(ready),
        estimated_pickup: iso(pickup),
        estimated_delivery: iso(delivery),
    };
}

/** Convenience: just the delivery ISO date (what normalizedQuote stores). */
function estimateDelivery(opts) {
    return estimateEta(opts).estimated_delivery;
}

module.exports = {
    DAY_MS,
    defaultIsBusinessDay,
    toDate,
    atUtcMidnight,
    rollToBusinessDay,
    addBusinessDays,
    estimateEta,
    estimateDelivery,
};
