'use strict';
/**
 * Dispatch Orchestration Engine — VOCABULARY + FACTORIES (War Room 4, Prompt 11).
 *
 * PURE: no DB, no I/O, no clock, no randomness. Defines the single stable
 * vocabulary the rule engine, the saga executor and the DB orchestrator all
 * speak: the four gating CONDITIONS the prompt names, the dispatch STATUS ladder,
 * the rule MODE taxonomy, the canonical SAGA step names, and the factories that
 * keep a condition-state map and a rule config shape-identical everywhere.
 *
 * The engine automates ONE decision: *should this shipment dispatch now?* It is
 * answered by the rule engine over a condition-state map; when the answer is yes
 * the orchestrator runs the dispatch saga (with compensating rollback on any
 * failure) and fans the outcome out to webhook subscribers.
 *
 *   Triggers dispatch when (the four gates, all required by default):
 *     • documents validated   — DOCUMENTS_VALIDATED
 *     • compliance passed      — COMPLIANCE_PASSED
 *     • customs ready          — CUSTOMS_READY
 *     • freight booked         — FREIGHT_BOOKED
 */

const ENGINE_VERSION = 'dispatch-orchestration@1.0.0';

// ── The four gating conditions (the prompt's dispatch triggers). ─────────────
const CONDITION = Object.freeze({
    DOCUMENTS_VALIDATED: 'documents_validated',
    COMPLIANCE_PASSED: 'compliance_passed',
    CUSTOMS_READY: 'customs_ready',
    FREIGHT_BOOKED: 'freight_booked',
});

const ALL_CONDITIONS = Object.freeze(Object.values(CONDITION));

// Default rule: every gate must be met before dispatch fires.
const DEFAULT_REQUIRED = Object.freeze([...ALL_CONDITIONS]);

const isCondition = (c) => ALL_CONDITIONS.includes(c);

// ── Dispatch status ladder. Order = lifecycle progression. ───────────────────
const STATUS = Object.freeze({
    PENDING: 'pending',          // created; awaiting condition signals
    READY: 'ready',              // rule satisfied; eligible to dispatch
    DISPATCHING: 'dispatching',  // the dispatch saga is executing
    DISPATCHED: 'dispatched',    // saga completed (terminal +)
    ROLLED_BACK: 'rolled_back',  // saga failed but compensated cleanly, OR a dispatched
                                 //   plan was manually rolled back (recoverable)
    FAILED: 'failed',            // saga failed AND compensation left dirty state (recoverable)
    CANCELLED: 'cancelled',      // withdrawn before dispatch (terminal)
});

const ALL_STATUSES = Object.freeze(Object.values(STATUS));

// Terminal states never auto-transition again. `dispatched`/`cancelled` are final.
const TERMINAL_STATUSES = Object.freeze([STATUS.DISPATCHED, STATUS.CANCELLED]);
// Resting states after a failed attempt — the input to retry/manual recovery.
const RECOVERABLE_STATUSES = Object.freeze([STATUS.FAILED, STATUS.ROLLED_BACK]);
// States from which a fresh dispatch may be (re)triggered.
const DISPATCHABLE_STATUSES = Object.freeze([STATUS.PENDING, STATUS.READY, STATUS.FAILED, STATUS.ROLLED_BACK]);

const isTerminal = (s) => TERMINAL_STATUSES.includes(s);
const isRecoverable = (s) => RECOVERABLE_STATUSES.includes(s);

// ── Rule modes — how the required conditions combine into a dispatch decision. ─
const RULE_MODE = Object.freeze({
    ALL_OF: 'all_of',         // every required condition met (default)
    ANY_OF: 'any_of',         // at least one required condition met
    THRESHOLD: 'threshold',   // at least `threshold` of the required conditions met
});

const VALID_RULE_MODES = Object.freeze(Object.values(RULE_MODE));

// ── Canonical dispatch saga steps (ordered). Each step is COMPENSABLE: the
// orchestrator registers an execute/compensate handler pair per name, and on any
// step failure the saga runs the compensators of the already-completed steps in
// reverse. ADVANCE_WORKFLOW is last so the irreversible state-machine move only
// happens once every reversible side effect has succeeded. ───────────────────
const STEP = Object.freeze({
    FINALIZE_CUSTOMS: 'finalize_customs',     // lock the customs filing for dispatch
    RELEASE_DOCUMENTS: 'release_documents',   // release the shipping docs to the carrier
    NOTIFY_CARRIER: 'notify_carrier',         // hand the booking to the freight carrier
    ADVANCE_WORKFLOW: 'advance_workflow',     // drive the workflow state machine to DISPATCHED
});

const DEFAULT_DISPATCH_STEPS = Object.freeze([
    STEP.FINALIZE_CUSTOMS,
    STEP.RELEASE_DOCUMENTS,
    STEP.NOTIFY_CARRIER,
    STEP.ADVANCE_WORKFLOW,
]);

// ── Audit event types (one immutable dispatch_events row per occurrence). ────
const EVENT_TYPE = Object.freeze({
    CREATED: 'created',
    CONDITION_SIGNAL: 'condition_signal',
    EVALUATED: 'evaluated',
    DISPATCH_STARTED: 'dispatch_started',
    STEP_COMPLETED: 'step_completed',
    STEP_FAILED: 'step_failed',
    ROLLBACK_STARTED: 'rollback_started',
    STEP_COMPENSATED: 'step_compensated',
    COMPENSATE_FAILED: 'compensate_failed',
    DISPATCHED: 'dispatched',
    FAILED: 'failed',
    ROLLED_BACK: 'rolled_back',
    CANCELLED: 'cancelled',
    RETRY: 'retry',
});

// ── Workflow-transition → condition mapping (the EVENT TRIGGER bridge). ───────
// Keyed by the workflow state just ENTERED (workflow_transition.to_state). The
// state machine (service/workflow/stateMachine.js) reaches each of these states
// exactly when the corresponding gate has been cleared:
//   verify_documents → COMPLIANCE_CHECK    ⇒ documents validated
//   clear_compliance → HS_CLASSIFICATION   ⇒ compliance passed
//   classify_hs      → CUSTOMS_READY       ⇒ customs ready
//   book_freight     → FREIGHT_BOOKED      ⇒ freight booked
const WORKFLOW_STATE_CONDITION = Object.freeze({
    COMPLIANCE_CHECK: CONDITION.DOCUMENTS_VALIDATED,
    HS_CLASSIFICATION: CONDITION.COMPLIANCE_PASSED,
    CUSTOMS_READY: CONDITION.CUSTOMS_READY,
    FREIGHT_BOOKED: CONDITION.FREIGHT_BOOKED,
});

/** The condition a workflow transition into `toState` signals, or null. */
function conditionForWorkflowState(toState) {
    return WORKFLOW_STATE_CONDITION[toState] || null;
}

// ── Factories ────────────────────────────────────────────────────────────────

/**
 * A fresh condition-state map: every required condition unmet. The map is the
 * single source of truth the rule engine reads.
 *   { [condition]: { met: boolean, source: string|null, detail: object, at: string|null } }
 */
function emptyConditionState(required = DEFAULT_REQUIRED) {
    const out = {};
    for (const c of required) {
        out[c] = { met: false, source: null, detail: {}, at: null };
    }
    return out;
}

/** A single condition slot (immutable update — never mutate the prior map). */
function conditionSlot({ met = false, source = null, detail = {}, at = null } = {}) {
    return { met: !!met, source: source || null, detail: detail || {}, at: at || null };
}

/**
 * Normalize a loose rule config into the canonical shape the rule engine reads.
 * Unknown conditions are dropped; an empty required set falls back to all four.
 */
function ruleConfig(input = {}) {
    const mode = VALID_RULE_MODES.includes(input.mode) ? input.mode : RULE_MODE.ALL_OF;
    let required = Array.isArray(input.required) ? input.required.filter(isCondition) : [];
    if (!required.length) required = [...DEFAULT_REQUIRED];
    // De-dup while preserving declaration order.
    required = required.filter((c, i) => required.indexOf(c) === i);

    let threshold = Number.parseInt(input.threshold, 10);
    if (!Number.isFinite(threshold) || threshold < 1) {
        threshold = mode === RULE_MODE.THRESHOLD ? required.length : required.length;
    }
    threshold = Math.min(threshold, required.length);

    return Object.freeze({
        mode,
        required: Object.freeze(required),
        threshold,
        // manual_hold pauses auto-dispatch even when the rule is satisfied (operator brake).
        manual_hold: input.manual_hold === true,
    });
}

module.exports = {
    ENGINE_VERSION,
    CONDITION,
    ALL_CONDITIONS,
    DEFAULT_REQUIRED,
    isCondition,
    STATUS,
    ALL_STATUSES,
    TERMINAL_STATUSES,
    RECOVERABLE_STATUSES,
    DISPATCHABLE_STATUSES,
    isTerminal,
    isRecoverable,
    RULE_MODE,
    VALID_RULE_MODES,
    STEP,
    DEFAULT_DISPATCH_STEPS,
    EVENT_TYPE,
    WORKFLOW_STATE_CONDITION,
    conditionForWorkflowState,
    emptyConditionState,
    conditionSlot,
    ruleConfig,
};
