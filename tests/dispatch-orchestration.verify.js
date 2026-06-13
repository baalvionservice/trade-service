'use strict';
/**
 * Dispatch Orchestration Engine — standalone verification harness (Prompt 11).
 *
 * jest is broken repo-wide (jest-runtime clearMocksOnScope skew), so this script
 * runs the PURE assertions (the rule engine, the compensating-rollback saga
 * executor and the schema vocabulary/factories) with a tiny built-in runner. No
 * DB, no network, no clock dependence.
 *
 *   node tests/dispatch-orchestration.verify.js
 */
const assert = require('assert');

const schema = require('../service/dispatch/schema');
const ruleEngine = require('../service/dispatch/ruleEngine');
const saga = require('../service/dispatch/saga');

const { CONDITION, STATUS, RULE_MODE, STEP } = schema;

let pass = 0;
let fail = 0;
const failures = [];

async function t(name, fn) {
    try {
        await fn();
        pass += 1;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        fail += 1;
        failures.push({ name, message: err.message });
        console.log(`  ✗ ${name}\n      ${err.message}`);
    }
}
function section(title) { console.log(`\n${title}`); }

// A fully-met condition state for the four gates.
const allMet = () => ({
    [CONDITION.DOCUMENTS_VALIDATED]: { met: true },
    [CONDITION.COMPLIANCE_PASSED]: { met: true },
    [CONDITION.CUSTOMS_READY]: { met: true },
    [CONDITION.FREIGHT_BOOKED]: { met: true },
});

(async () => {
    // ── schema ─────────────────────────────────────────────────────────────────
    section('schema');
    await t('the four gating conditions are the prompt triggers', () => {
        assert.deepStrictEqual([...schema.ALL_CONDITIONS].sort(), [
            'compliance_passed', 'customs_ready', 'documents_validated', 'freight_booked',
        ]);
        assert.deepStrictEqual([...schema.DEFAULT_REQUIRED].sort(), [...schema.ALL_CONDITIONS].sort());
    });
    await t('ruleConfig defaults to ALL_OF over all four gates', () => {
        const r = schema.ruleConfig({});
        assert.strictEqual(r.mode, RULE_MODE.ALL_OF);
        assert.strictEqual(r.required.length, 4);
        assert.strictEqual(r.threshold, 4);
        assert.strictEqual(r.manual_hold, false);
    });
    await t('ruleConfig normalizes threshold + drops unknown conditions', () => {
        const r = schema.ruleConfig({ mode: 'threshold', threshold: 2, required: ['customs_ready', 'bogus', 'freight_booked', 'customs_ready'] });
        assert.strictEqual(r.mode, 'threshold');
        assert.deepStrictEqual([...r.required], ['customs_ready', 'freight_booked']); // de-dup + drop unknown
        assert.strictEqual(r.threshold, 2);
    });
    await t('ruleConfig clamps an over-large threshold to the required count', () => {
        const r = schema.ruleConfig({ mode: 'threshold', threshold: 99, required: ['customs_ready'] });
        assert.strictEqual(r.threshold, 1);
    });
    await t('status helpers identify terminal + recoverable', () => {
        assert.strictEqual(schema.isTerminal(STATUS.DISPATCHED), true);
        assert.strictEqual(schema.isTerminal(STATUS.CANCELLED), true);
        assert.strictEqual(schema.isTerminal(STATUS.FAILED), false);
        assert.strictEqual(schema.isRecoverable(STATUS.FAILED), true);
        assert.strictEqual(schema.isRecoverable(STATUS.ROLLED_BACK), true);
        assert.strictEqual(schema.isRecoverable(STATUS.DISPATCHED), false);
    });
    await t('conditionForWorkflowState maps the four workflow gates', () => {
        assert.strictEqual(schema.conditionForWorkflowState('COMPLIANCE_CHECK'), CONDITION.DOCUMENTS_VALIDATED);
        assert.strictEqual(schema.conditionForWorkflowState('HS_CLASSIFICATION'), CONDITION.COMPLIANCE_PASSED);
        assert.strictEqual(schema.conditionForWorkflowState('CUSTOMS_READY'), CONDITION.CUSTOMS_READY);
        assert.strictEqual(schema.conditionForWorkflowState('FREIGHT_BOOKED'), CONDITION.FREIGHT_BOOKED);
        assert.strictEqual(schema.conditionForWorkflowState('IN_TRANSIT'), null);
    });
    await t('emptyConditionState seeds every required gate unmet', () => {
        const s = schema.emptyConditionState(schema.DEFAULT_REQUIRED);
        assert.strictEqual(Object.keys(s).length, 4);
        assert.ok(Object.values(s).every((slot) => slot.met === false));
    });
    await t('the four canonical saga steps end with advance_workflow', () => {
        assert.deepStrictEqual([...schema.DEFAULT_DISPATCH_STEPS], [
            STEP.FINALIZE_CUSTOMS, STEP.RELEASE_DOCUMENTS, STEP.NOTIFY_CARRIER, STEP.ADVANCE_WORKFLOW,
        ]);
        assert.strictEqual(schema.DEFAULT_DISPATCH_STEPS[schema.DEFAULT_DISPATCH_STEPS.length - 1], STEP.ADVANCE_WORKFLOW);
    });

    // ── rule engine ──────────────────────────────────────────────────────────
    section('rule engine');
    await t('ALL_OF holds until every gate is met, then dispatches', () => {
        const rule = schema.ruleConfig({});
        let state = schema.emptyConditionState(rule.required);
        assert.strictEqual(ruleEngine.evaluate(state, rule).decision, 'hold');

        state = ruleEngine.applySignal(state, CONDITION.DOCUMENTS_VALIDATED, { met: true });
        state = ruleEngine.applySignal(state, CONDITION.COMPLIANCE_PASSED, { met: true });
        state = ruleEngine.applySignal(state, CONDITION.CUSTOMS_READY, { met: true });
        let d = ruleEngine.evaluate(state, rule);
        assert.strictEqual(d.decision, 'hold');     // 3/4 — still held
        assert.strictEqual(d.score, 75);
        assert.deepStrictEqual(d.missing, [CONDITION.FREIGHT_BOOKED]);

        state = ruleEngine.applySignal(state, CONDITION.FREIGHT_BOOKED, { met: true });
        d = ruleEngine.evaluate(state, rule);
        assert.strictEqual(d.satisfied, true);
        assert.strictEqual(d.decision, 'dispatch'); // 4/4 — fires
        assert.strictEqual(d.score, 100);
        assert.deepStrictEqual(d.missing, []);
    });
    await t('ANY_OF dispatches on the first met gate', () => {
        const rule = schema.ruleConfig({ mode: 'any_of' });
        let state = schema.emptyConditionState(rule.required);
        assert.strictEqual(ruleEngine.evaluate(state, rule).decision, 'hold');
        state = ruleEngine.applySignal(state, CONDITION.FREIGHT_BOOKED, { met: true });
        assert.strictEqual(ruleEngine.evaluate(state, rule).decision, 'dispatch');
    });
    await t('THRESHOLD dispatches once N gates are met', () => {
        const rule = schema.ruleConfig({ mode: 'threshold', threshold: 2 });
        let state = schema.emptyConditionState(rule.required);
        state = ruleEngine.applySignal(state, CONDITION.DOCUMENTS_VALIDATED, { met: true });
        assert.strictEqual(ruleEngine.evaluate(state, rule).decision, 'hold'); // 1/4 < 2
        state = ruleEngine.applySignal(state, CONDITION.CUSTOMS_READY, { met: true });
        assert.strictEqual(ruleEngine.evaluate(state, rule).decision, 'dispatch'); // 2/4 >= 2
    });
    await t('manual_hold keeps a satisfied rule held (held=true, decision=hold)', () => {
        const rule = schema.ruleConfig({ manual_hold: true });
        const d = ruleEngine.evaluate(allMet(), rule);
        assert.strictEqual(d.satisfied, true);
        assert.strictEqual(d.held, true);
        assert.strictEqual(d.decision, 'hold');
    });
    await t('applySignal is immutable (returns a new map, leaves the input intact)', () => {
        const before = schema.emptyConditionState(schema.DEFAULT_REQUIRED);
        const after = ruleEngine.applySignal(before, CONDITION.CUSTOMS_READY, { met: true, source: 'x' });
        assert.strictEqual(before[CONDITION.CUSTOMS_READY].met, false); // unchanged
        assert.strictEqual(after[CONDITION.CUSTOMS_READY].met, true);
        assert.notStrictEqual(before, after);
    });
    await t('a boolean-true slot is treated as met (tolerant input)', () => {
        const rule = schema.ruleConfig({ mode: 'any_of' });
        const d = ruleEngine.evaluate({ [CONDITION.FREIGHT_BOOKED]: true }, rule);
        assert.strictEqual(d.decision, 'dispatch');
    });

    // ── saga executor (failure rollback) ───────────────────────────────────────
    section('saga executor / failure rollback');
    const mkStep = (name, log, { fail: shouldFail = false } = {}) => ({
        name,
        execute: async () => { if (shouldFail) throw new Error(`boom:${name}`); log.push(`exec:${name}`); return { name }; },
        compensate: async () => { log.push(`comp:${name}`); },
    });

    await t('happy path runs every step in order, no compensation', async () => {
        const log = [];
        const res = await saga.runSaga([mkStep('a', log), mkStep('b', log), mkStep('c', log)], {});
        assert.strictEqual(res.ok, true);
        assert.deepStrictEqual(res.completed.map((c) => c.name), ['a', 'b', 'c']);
        assert.deepStrictEqual(log, ['exec:a', 'exec:b', 'exec:c']); // no comp:* entries
    });
    await t('failure at step 3 compensates steps 2,1 in REVERSE order', async () => {
        const log = [];
        const res = await saga.runSaga([
            mkStep('a', log),
            mkStep('b', log),
            mkStep('c', log, { fail: true }),
            mkStep('d', log),
        ], {});
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.failedStep, 'c');
        assert.strictEqual(res.rolledBack, true);
        assert.deepStrictEqual(res.completed, ['a', 'b']);    // c failed, d never ran
        assert.deepStrictEqual(res.compensated, ['b', 'a']);  // reverse order
        assert.deepStrictEqual(log, ['exec:a', 'exec:b', 'comp:b', 'comp:a']);
    });
    await t('failure at the FIRST step compensates nothing (rolledBack clean)', async () => {
        const log = [];
        const res = await saga.runSaga([mkStep('a', log, { fail: true }), mkStep('b', log)], {});
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.failedStep, 'a');
        assert.strictEqual(res.rolledBack, true);
        assert.deepStrictEqual(res.compensated, []);
        assert.deepStrictEqual(log, []);
    });
    await t('a failing compensator marks the saga dirty (rolledBack=false)', async () => {
        const log = [];
        const badComp = {
            name: 'b',
            execute: async () => { log.push('exec:b'); return {}; },
            compensate: async () => { throw new Error('comp_failed'); },
        };
        const res = await saga.runSaga([mkStep('a', log), badComp, mkStep('c', log, { fail: true })], {});
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.rolledBack, false); // compensation incomplete → dirty/failed
        assert.strictEqual(res.compensationErrors.length, 1);
        assert.strictEqual(res.compensationErrors[0].step, 'b');
        assert.deepStrictEqual(res.compensated, ['a']); // a still compensated
    });
    await t('a step with no compensator is skipped cleanly during rollback', async () => {
        const log = [];
        const noComp = { name: 'b', execute: async () => { log.push('exec:b'); return {}; } };
        const res = await saga.runSaga([mkStep('a', log), noComp, mkStep('c', log, { fail: true })], {});
        assert.strictEqual(res.rolledBack, true);
        assert.deepStrictEqual(res.compensated, ['b', 'a']); // b recorded as compensated (nothing to undo)
    });
    await t('standalone compensate() unwinds completed steps in reverse', async () => {
        const log = [];
        const completed = [
            { step: mkStep('a', log), result: {} },
            { step: mkStep('b', log), result: {} },
            { step: mkStep('c', log), result: {} },
        ];
        const { compensated, compensationErrors } = await saga.compensate(completed, {});
        assert.deepStrictEqual(compensated, ['c', 'b', 'a']);
        assert.strictEqual(compensationErrors.length, 0);
        assert.deepStrictEqual(log, ['comp:c', 'comp:b', 'comp:a']);
    });
    await t('lifecycle hooks fire for steps, failure, rollback + compensation', async () => {
        const events = [];
        const hooks = {
            onStepDone: ({ step }) => events.push(`done:${step}`),
            onStepFail: ({ step }) => events.push(`fail:${step}`),
            onRollbackStart: ({ failedStep }) => events.push(`rollback:${failedStep}`),
            onCompensateDone: ({ step }) => events.push(`comp:${step}`),
        };
        const log = [];
        await saga.runSaga([mkStep('a', log), mkStep('b', log, { fail: true })], {}, hooks);
        assert.deepStrictEqual(events, ['done:a', 'fail:b', 'rollback:b', 'comp:a']);
    });

    // ── engine module loads (sanity — no DB calls made) ────────────────────────
    section('engine module surface');
    await t('dispatchEngine exposes the orchestration API + pluggable step handlers', () => {
        const engine = require('../service/dispatch/dispatchEngine');
        for (const fn of ['createPlan', 'signalCondition', 'onWorkflowTransition', 'triggerDispatch', 'rollback', 'retryDispatch', 'cancel', 'registerStepHandler', 'resetStepHandlers']) {
            assert.strictEqual(typeof engine[fn], 'function', `missing engine.${fn}`);
        }
        // Default handlers cover all four canonical steps.
        for (const step of schema.DEFAULT_DISPATCH_STEPS) {
            assert.ok(engine.DEFAULT_STEP_HANDLERS[step], `missing default handler for ${step}`);
            assert.strictEqual(typeof engine.DEFAULT_STEP_HANDLERS[step].execute, 'function');
        }
    });
    await t('registerStepHandler rejects a handler without execute()', () => {
        const engine = require('../service/dispatch/dispatchEngine');
        assert.throws(() => engine.registerStepHandler('x', {}), /execute/);
        engine.resetStepHandlers();
    });

    // ── summary ───────────────────────────────────────────────────────────────
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`dispatch-orchestration.verify — ${pass} passed, ${fail} failed (${pass + fail} total)`);
    if (fail) {
        console.log('\nFailures:');
        failures.forEach((f) => console.log(`  • ${f.name}: ${f.message}`));
        process.exit(1);
    }
    process.exit(0);
})();
