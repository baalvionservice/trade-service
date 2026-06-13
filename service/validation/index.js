'use strict';
/**
 * AI Document Validation Engine (Prompt 5) — public surface.
 *
 *   schema           error-reporting vocabulary + finding() factory
 *   normalize        value normalizers (currency / weight / number / address)
 *   rules            deterministic rules engine (6 checks)
 *   aiClassifier     pluggable AI classification layer (heuristic default)
 *   report           validation_report builder + readiness impact
 *   engine           DB-backed orchestrator (validatePayload / validateDocument)
 */
module.exports = {
    schema: require('./schema'),
    normalize: require('./normalize'),
    rules: require('./rules'),
    aiClassifier: require('./aiClassifier'),
    report: require('./report'),
    engine: require('./validationEngine'),
};
