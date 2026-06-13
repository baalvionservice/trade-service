'use strict';
/**
 * Dispatch Orchestration Engine — RULE ENGINE (War Room 4, Prompt 11).
 *
 * PURE: no DB, no I/O, no clock. Given a condition-state map and a (normalized)
 * rule config it returns exactly one decision, so it is exhaustively
 * unit-testable on its own. This is the brain that answers the engine's single
 * question — *should this shipment dispatch now?* — by combining the four gating
 * conditions per the configured rule mode.
 *
 *   ALL_OF     every required condition met            (default — all four gates)
 *   ANY_OF     at least one required condition met
 *   THRESHOLD  at least `threshold` of the required met
 *
 * A `manual_hold` rule flag forces a HOLD even when the conditions are satisfied,
 * so an operator can pause auto-dispatch without losing the readiness signal.
 */
const { RULE_MODE, conditionSlot } = require('./schema');

/** Was a single condition slot met? Tolerates a missing / boolean / object slot. */
function slotMet(slot) {
    if (slot === true) return true;
    if (!slot || typeof slot !== 'object') return false;
    return slot.met === true;
}

/**
 * Evaluate the dispatch rule against the current condition state.
 *
 * @param {object} conditionState  { [condition]: { met, source, detail, at } | boolean }
 * @param {object} rule            normalized rule config (schema.ruleConfig)
 * @returns {{
 *   satisfied: boolean,          // rule predicate true (ignoring manual_hold)
 *   decision: 'dispatch'|'hold', // satisfied && !manual_hold ⇒ 'dispatch'
 *   held: boolean,               // satisfied but paused by manual_hold
 *   mode: string,
 *   met: string[],               // required conditions currently met
 *   missing: string[],           // required conditions not yet met
 *   metCount: number,
 *   requiredCount: number,
 *   threshold: number,
 *   score: number,               // 0–100 readiness toward the rule
 * }}
 */
function evaluate(conditionState = {}, rule = {}) {
    const required = Array.isArray(rule.required) ? rule.required : [];
    const mode = rule.mode || RULE_MODE.ALL_OF;
    const requiredCount = required.length;

    const met = [];
    const missing = [];
    for (const cond of required) {
        if (slotMet(conditionState[cond])) met.push(cond);
        else missing.push(cond);
    }
    const metCount = met.length;

    let threshold = Number.isFinite(rule.threshold) ? rule.threshold : requiredCount;
    if (mode === RULE_MODE.ALL_OF) threshold = requiredCount;
    if (mode === RULE_MODE.ANY_OF) threshold = Math.min(1, requiredCount) || 0;
    threshold = Math.min(threshold, requiredCount);

    let satisfied;
    switch (mode) {
        case RULE_MODE.ANY_OF:
            satisfied = requiredCount > 0 && metCount >= 1;
            break;
        case RULE_MODE.THRESHOLD:
            satisfied = requiredCount > 0 && metCount >= threshold;
            break;
        case RULE_MODE.ALL_OF:
        default:
            satisfied = requiredCount > 0 && missing.length === 0;
            break;
    }

    const held = satisfied && rule.manual_hold === true;
    const score = requiredCount === 0 ? 0 : Math.round((metCount / requiredCount) * 100);

    return {
        satisfied,
        decision: satisfied && !held ? 'dispatch' : 'hold',
        held,
        mode,
        met,
        missing,
        metCount,
        requiredCount,
        threshold,
        score,
    };
}

/**
 * Apply a condition signal to a condition-state map IMMUTABLY, returning a NEW
 * map (never mutates the input). Conditions outside the rule's required set are
 * still recorded (audit / future rules) but do not affect the decision.
 */
function applySignal(conditionState, condition, signal = {}) {
    return {
        ...conditionState,
        [condition]: conditionSlot({
            met: signal.met !== undefined ? signal.met : true,
            source: signal.source || null,
            detail: signal.detail || {},
            at: signal.at || null,
        }),
    };
}

module.exports = { evaluate, applySignal, slotMet };
