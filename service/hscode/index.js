'use strict';
/**
 * HS Code Intelligence Engine (Prompt 7) — public surface.
 *
 *   schema         vocabulary (METHOD / FLAG / confidence bands) + factories
 *   normalize      HS-code + product-text normalizers
 *   hsDatabase     canonical HS reference dataset + multi-country tariff lines
 *   search         keyword/token search over the HS database (the search API)
 *   aiSuggester    pluggable AI suggestion engine (mockable; heuristic default)
 *   fallbackRules  deterministic fallback rules engine (coarse chapter mapping)
 *   compliance     compliance-flag derivation (chapter + entry + tariff layers)
 *   duty           duty estimation hooks (pluggable rate-provider seam)
 *   report         hs_suggestion_report builder (fuse → flags → duty)
 *   engine         DB-backed orchestrator (suggest / classifyProduct / lookup)
 */
module.exports = {
    schema: require('./schema'),
    normalize: require('./normalize'),
    hsDatabase: require('./hsDatabase'),
    search: require('./search'),
    aiSuggester: require('./aiSuggester'),
    fallbackRules: require('./fallbackRules'),
    compliance: require('./compliance'),
    duty: require('./duty'),
    report: require('./report'),
    engine: require('./hsEngine'),
};
