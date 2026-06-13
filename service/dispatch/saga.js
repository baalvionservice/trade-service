'use strict';
/**
 * Dispatch Orchestration Engine — SAGA EXECUTOR / FAILURE-ROLLBACK (Prompt 11).
 *
 * PURE orchestration: the executor itself has no DB, no I/O and no clock — the
 * STEP handlers do the side effects; this module owns only the ordering and the
 * compensating-rollback logic, so it is exhaustively unit-testable with in-memory
 * handlers.
 *
 * A dispatch is a multi-step distributed action (finalize customs → release
 * documents → notify carrier → advance the workflow). There is no single ACID
 * transaction across those external effects, so we use the SAGA pattern: run the
 * steps forward, and if ANY step fails, run the COMPENSATING action of every
 * already-completed step in REVERSE order to undo the partial work. The shipment
 * is never left half-dispatched silently — either every step succeeds, or the
 * completed ones are compensated and the plan lands in a clean, recoverable rest
 * state.
 *
 * A step is: { name, execute(ctx) → result, compensate?(ctx, result) }.
 * Hooks (onStepStart / onStepDone / onStepFail / onCompensateDone /
 * onCompensateFail) let the caller append an immutable audit row per event while
 * keeping this module side-effect free.
 */

const noop = async () => {};

/** Normalize the optional lifecycle hooks so the executor never null-checks. */
function normalizeHooks(hooks = {}) {
    return {
        onStepStart: hooks.onStepStart || noop,
        onStepDone: hooks.onStepDone || noop,
        onStepFail: hooks.onStepFail || noop,
        onRollbackStart: hooks.onRollbackStart || noop,
        onCompensateDone: hooks.onCompensateDone || noop,
        onCompensateFail: hooks.onCompensateFail || noop,
    };
}

/**
 * Compensate a set of completed steps in REVERSE order. Best-effort: a failing
 * compensator does NOT abort the rollback of the others — every completed step
 * gets its compensator attempted, and the failures are collected so the caller
 * can decide between a clean `rolled_back` and a dirty `failed`.
 *
 * @returns {{ compensated: string[], compensationErrors: Array<{step,error}> }}
 */
async function compensate(completed, ctx, hooks = {}) {
    const h = normalizeHooks(hooks);
    const compensated = [];
    const compensationErrors = [];

    for (let i = completed.length - 1; i >= 0; i -= 1) {
        const { step, result } = completed[i];
        if (typeof step.compensate !== 'function') {
            // No compensator ⇒ nothing to undo for this step (e.g. a pure read).
            compensated.push(step.name);
            continue;
        }
        try {
            await step.compensate(ctx, result);
            compensated.push(step.name);
            await h.onCompensateDone({ step: step.name });
        } catch (err) {
            compensationErrors.push({ step: step.name, error: String((err && err.message) || err) });
            await h.onCompensateFail({ step: step.name, error: err });
        }
    }
    return { compensated, compensationErrors };
}

/**
 * Run a saga forward; on the first failing step, roll the completed steps back.
 *
 * @param {Array<{name,execute,compensate?}>} steps
 * @param {object} ctx                 shared context handed to every handler
 * @param {object} [hooks]             lifecycle hooks (see normalizeHooks)
 * @returns {Promise<
 *   | { ok: true,  completed: Array<{name,result}> }
 *   | { ok: false, failedStep: string, error: string,
 *       completed: string[], compensated: string[],
 *       compensationErrors: Array<{step,error}>, rolledBack: boolean }
 * >}
 */
async function runSaga(steps = [], ctx = {}, hooks = {}) {
    const h = normalizeHooks(hooks);
    const completed = []; // [{ step, result }] — in execution order

    for (const step of steps) {
        await h.onStepStart({ step: step.name });
        try {
            const result = await step.execute(ctx);
            completed.push({ step, result });
            await h.onStepDone({ step: step.name, result });
        } catch (err) {
            const error = String((err && err.message) || err);
            await h.onStepFail({ step: step.name, error: err });

            // ── Roll back everything that already succeeded, in reverse. ──
            await h.onRollbackStart({ failedStep: step.name, completed: completed.map((c) => c.step.name) });
            const { compensated, compensationErrors } = await compensate(completed, ctx, h);

            return {
                ok: false,
                failedStep: step.name,
                error,
                completed: completed.map((c) => c.step.name),
                compensated,
                compensationErrors,
                rolledBack: compensationErrors.length === 0,
            };
        }
    }

    return { ok: true, completed: completed.map((c) => ({ name: c.step.name, result: c.result })) };
}

module.exports = { runSaga, compensate };
