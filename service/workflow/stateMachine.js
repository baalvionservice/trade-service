'use strict';
/**
 * Shipment Workflow — DETERMINISTIC state machine definition (War Room 4, Prompt 2).
 *
 * This module is PURE: no DB, no I/O, no clock, no randomness. Given a current
 * state and an event it returns exactly one outcome, so it is exhaustively
 * unit-testable on its own. The DB-backed engine (workflowEngine.js) wraps it
 * with persistence, idempotency, optimistic locking and webhook fan-out.
 *
 * Lifecycle (linear happy path):
 *   CREATED → DOCUMENT_COLLECTION → DOCUMENT_VERIFICATION → COMPLIANCE_CHECK →
 *   HS_CLASSIFICATION → CUSTOMS_READY → FREIGHT_BOOKED → DISPATCH_READY →
 *   DISPATCHED → IN_TRANSIT → DELIVERED → COMPLETED
 *
 * Terminal states: COMPLETED, FAILED.
 */

// ── States ───────────────────────────────────────────────────────────────────
const STATES = Object.freeze({
    CREATED: 'CREATED',
    DOCUMENT_COLLECTION: 'DOCUMENT_COLLECTION',
    DOCUMENT_VERIFICATION: 'DOCUMENT_VERIFICATION',
    COMPLIANCE_CHECK: 'COMPLIANCE_CHECK',
    HS_CLASSIFICATION: 'HS_CLASSIFICATION',
    CUSTOMS_READY: 'CUSTOMS_READY',
    FREIGHT_BOOKED: 'FREIGHT_BOOKED',
    DISPATCH_READY: 'DISPATCH_READY',
    DISPATCHED: 'DISPATCHED',
    IN_TRANSIT: 'IN_TRANSIT',
    DELIVERED: 'DELIVERED',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED',
});

const ALL_STATES = Object.freeze(Object.values(STATES));

// Terminal states have no outgoing transitions — dispatch is rejected on them.
const TERMINAL_STATES = Object.freeze([STATES.COMPLETED, STATES.FAILED]);

// Workflow-level status (rolled up from current_state for cheap filtering).
const WORKFLOW_STATUSES = Object.freeze(['active', 'completed', 'failed']);

// Non-terminal states — the valid `from` set for the universal `fail` event.
const NON_TERMINAL = ALL_STATES.filter((s) => !TERMINAL_STATES.includes(s));

/**
 * Transition table — the single source of truth.
 *
 * Each event maps to exactly one target state plus the set of states it may be
 * applied from. Because (from, event) → to is a function (no event appears twice
 * with overlapping `from` sets resolving to different `to`), the machine is
 * deterministic.
 *
 *   forward:  drives the happy path one stage onward
 *   rework:   reject_documents loops verification back to collection
 *   terminal: complete / fail
 */
const TRANSITIONS = Object.freeze({
    // ── Forward path ──
    collect_documents: { from: [STATES.CREATED], to: STATES.DOCUMENT_COLLECTION, kind: 'forward' },
    submit_documents: { from: [STATES.DOCUMENT_COLLECTION], to: STATES.DOCUMENT_VERIFICATION, kind: 'forward' },
    verify_documents: { from: [STATES.DOCUMENT_VERIFICATION], to: STATES.COMPLIANCE_CHECK, kind: 'forward' },
    clear_compliance: { from: [STATES.COMPLIANCE_CHECK], to: STATES.HS_CLASSIFICATION, kind: 'forward' },
    classify_hs: { from: [STATES.HS_CLASSIFICATION], to: STATES.CUSTOMS_READY, kind: 'forward' },
    book_freight: { from: [STATES.CUSTOMS_READY], to: STATES.FREIGHT_BOOKED, kind: 'forward' },
    ready_dispatch: { from: [STATES.FREIGHT_BOOKED], to: STATES.DISPATCH_READY, kind: 'forward' },
    dispatch: { from: [STATES.DISPATCH_READY], to: STATES.DISPATCHED, kind: 'forward' },
    depart: { from: [STATES.DISPATCHED], to: STATES.IN_TRANSIT, kind: 'forward' },
    deliver: { from: [STATES.IN_TRANSIT], to: STATES.DELIVERED, kind: 'forward' },
    complete: { from: [STATES.DELIVERED], to: STATES.COMPLETED, kind: 'terminal' },

    // ── Rework (deterministic backward edge) ──
    reject_documents: { from: [STATES.DOCUMENT_VERIFICATION], to: STATES.DOCUMENT_COLLECTION, kind: 'rework' },

    // ── Universal failure — allowed from any non-terminal state ──
    fail: { from: NON_TERMINAL, to: STATES.FAILED, kind: 'terminal' },
});

const EVENTS = Object.freeze(Object.keys(TRANSITIONS));

// The single canonical forward event available from each non-terminal state
// (used by the /advance convenience endpoint). `fail`/`reject_documents` are
// deliberately excluded — advancing means moving the happy path forward.
const FORWARD_EVENT_BY_STATE = Object.freeze(
    EVENTS.filter((e) => TRANSITIONS[e].kind === 'forward' || (TRANSITIONS[e].kind === 'terminal' && e === 'complete'))
        .reduce((acc, e) => {
            for (const from of TRANSITIONS[e].from) acc[from] = e;
            return acc;
        }, {}),
);

const isState = (s) => ALL_STATES.includes(s);
const isTerminal = (s) => TERMINAL_STATES.includes(s);
const isEvent = (e) => EVENTS.includes(e);

/** Events that may legally be applied from `state`, in declaration order. */
function allowedEvents(state) {
    if (!isState(state)) return [];
    return EVENTS.filter((e) => TRANSITIONS[e].from.includes(state));
}

/** The canonical next forward state from `state`, or null if none / terminal. */
function nextForwardState(state) {
    const e = FORWARD_EVENT_BY_STATE[state];
    return e ? TRANSITIONS[e].to : null;
}

/**
 * Pure transition decision. Never throws — returns a tagged result so callers
 * can decide how to surface an invalid transition.
 *
 * @returns {{ ok: true, from, event, to, kind } | { ok: false, code, message, from, event, allowed }}
 */
function decide(fromState, event) {
    if (!isState(fromState)) {
        return { ok: false, code: 'UNKNOWN_STATE', message: `Unknown state: ${fromState}`, from: fromState, event, allowed: [] };
    }
    if (!isEvent(event)) {
        return { ok: false, code: 'UNKNOWN_EVENT', message: `Unknown event: ${event}`, from: fromState, event, allowed: allowedEvents(fromState) };
    }
    if (isTerminal(fromState)) {
        return { ok: false, code: 'TERMINAL_STATE', message: `Workflow is in terminal state ${fromState}; no transitions allowed`, from: fromState, event, allowed: [] };
    }
    const t = TRANSITIONS[event];
    if (!t.from.includes(fromState)) {
        return {
            ok: false,
            code: 'INVALID_TRANSITION',
            message: `Event '${event}' is not valid from state '${fromState}'`,
            from: fromState,
            event,
            allowed: allowedEvents(fromState),
        };
    }
    return { ok: true, from: fromState, event, to: t.to, kind: t.kind };
}

/** Roll a state up to the coarse workflow status. */
function statusForState(state) {
    if (state === STATES.COMPLETED) return 'completed';
    if (state === STATES.FAILED) return 'failed';
    return 'active';
}

module.exports = {
    STATES,
    ALL_STATES,
    TERMINAL_STATES,
    NON_TERMINAL,
    WORKFLOW_STATUSES,
    TRANSITIONS,
    EVENTS,
    FORWARD_EVENT_BY_STATE,
    INITIAL_STATE: STATES.CREATED,
    isState,
    isTerminal,
    isEvent,
    allowedEvents,
    nextForwardState,
    decide,
    statusForState,
};
