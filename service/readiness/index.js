'use strict';
/**
 * Shipment Readiness Score Engine (War Room 4, Prompt 6) — public surface.
 *
 *   scoring   PURE weighted scorer — readiness + compliance/documentation/
 *             logistics/risk component scores (deterministic, clock-injected).
 *   engine    DB-backed orchestrator — input assembly, persistence, caching and
 *             event-triggered recalculation (recalculate / getLatest / triggerRecalc).
 */
module.exports = {
    scoring: require('./scoring'),
    engine: require('./readinessEngine'),
};
