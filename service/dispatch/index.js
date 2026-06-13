'use strict';
/**
 * Dispatch Orchestration Engine (War Room 4, Prompt 11) — public surface.
 *
 *   schema     vocabulary (CONDITION / STATUS / RULE_MODE / STEP) + factories (PURE)
 *   ruleEngine condition-state → dispatch decision (PURE)
 *   saga       compensating-rollback saga executor (PURE)
 *   engine     DB-backed orchestrator (createPlan / signalCondition / onWorkflowTransition
 *              / triggerDispatch / rollback / retry / reads) + pluggable step handlers
 *   webhooks   signed, retry-safe webhook fan-out + delivery processor
 *
 * The engine automates dispatch the moment a shipment's four gates clear —
 * documents validated, compliance passed, customs ready, freight booked — via a
 * rule engine, workflow-driven event triggers, a webhook system and a saga-based
 * failure-rollback system.
 */
module.exports = {
    schema: require('./schema'),
    ruleEngine: require('./ruleEngine'),
    saga: require('./saga'),
    engine: require('./dispatchEngine'),
    webhooks: require('./webhookDispatcher'),
};
