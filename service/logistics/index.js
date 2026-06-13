'use strict';
/**
 * Logistics Optimization Agent (War Room 4, Prompt 14) — public surface.
 *
 *   schema          vocabulary (MODE / STRATEGY / FAILURE_KIND / weights) + factories (PURE)
 *   normalize       canonical optimization-request normalizer + validation (PURE)
 *   network         the lane/hub network SSOT + geo-resolution + pluggable lane provider (PURE)
 *   carrierRates    carrier selection per leg + leg pricing + pluggable rate provider (PURE)
 *   routeBuilder    candidate end-to-end route enumeration over the network (PURE)
 *   scoring         the SCORING ENGINE — cost-vs-speed analysis → cheapest/fastest/balanced (PURE)
 *   fallbackRules   synthetic-route + constraint-relaxation + default-mode FALLBACK RULES (PURE)
 *   apiIntegration  the API INTEGRATION LAYER — provider registry + retry + classification (PURE)
 *   optimizer       the PURE orchestrator — request → routes → scored picks
 *   engine          the DB-backed orchestrator — persistence + selection + audit
 *
 * The three concerns the prompt asks for map to:
 *   carrier selection  → carrierRates (per-leg) + routeBuilder (which carrier flies each hop)
 *   route optimization → network + routeBuilder (multi-leg path search across the graph)
 *   cost vs speed      → scoring (min-max normalized composite) → cheapest/fastest/balanced
 *
 * Outputs: optimizer.optimize() returns { cheapest, fastest, balanced, recommended }.
 * Includes: a scoring engine (scoring.js), fallback rules (fallbackRules.js), and an
 * API integration layer (apiIntegration.js).
 */
module.exports = {
    schema: require('./schema'),
    normalize: require('./normalize'),
    network: require('./network'),
    carrierRates: require('./carrierRates'),
    routeBuilder: require('./routeBuilder'),
    scoring: require('./scoring'),
    fallbackRules: require('./fallbackRules'),
    apiIntegration: require('./apiIntegration'),
    optimizer: require('./optimizer'),
    engine: require('./logisticsEngine'),
};
