'use strict';
/**
 * Compliance & Sanctions Engine (War Room 4, Prompt 8) — public surface.
 *
 *   schema    vocabulary (DECISION / SEVERITY / CHECK / HOOK_STATUS) + factories
 *   normalize country / party / goods / HS normalizers + fuzzy matchers
 *   dataset   PURE reference data (sanctioned parties, controlled goods, bans) —
 *             single source of truth, seeded into the global tables
 *   rules     PURE rules engine — sanctioned countries/parties, restricted +
 *             dual-use + prohibited goods, export/import bans, blacklist/whitelist
 *   severity  PURE violation severity scoring → risk_score + severity + decision
 *   kycAml    pluggable KYC/AML hooks (registerProvider; deterministic default)
 *   report    PURE report builder (normalize → rules → severity → assemble)
 *   engine    DB-backed orchestrator (screen / screenOperation / getLatest /
 *             triggerScreen) with reference-data + tenant-list loading + caching
 */
module.exports = {
    schema: require('./schema'),
    normalize: require('./normalize'),
    dataset: require('./dataset'),
    rules: require('./rules'),
    severity: require('./severity'),
    kycAml: require('./kycAml'),
    report: require('./report'),
    engine: require('./complianceEngine'),
};
