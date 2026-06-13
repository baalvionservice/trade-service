'use strict';
/**
 * AI Document Validation Engine — DB-backed ORCHESTRATOR (Prompt 5).
 *
 * Wraps the four PURE layers (rules, aiClassifier, report, normalize) with the
 * persistence + context-loading the pure modules deliberately avoid:
 *
 *   • validatePayload()  — stateless. Validate an explicit document payload
 *                          (extracted + expected) and return a validation_report.
 *                          No DB. The pure pipeline, async only because the AI
 *                          provider may be remote.
 *
 *   • validateDocument() — load a persisted document, derive its EXPECTED
 *                          reference from the parent trade operation and its
 *                          sibling source-of-truth documents (cross-document
 *                          consistency), validate, and persist the report as a
 *                          DocumentValidation row.
 *
 * The EXPECTED reference is layered, lowest → highest precedence:
 *   1. trade operation canonical fields (currency, origin/destination, hs_code)
 *   2. operation.metadata.expected           (values authored on the operation)
 *   3. sibling source-of-truth documents     (invoice → currency/qty/tax,
 *                                              packing_list → weights, b/l → parties)
 *   4. caller-supplied expectedOverride       (explicit, wins)
 */

const db = require('../../models');
const rules = require('./rules');
const aiClassifier = require('./aiClassifier');
const report = require('./report');
const { AppError } = require('../../utils/errors');

let readiness = null; // lazy require to avoid a require cycle
function readinessEngine() {
    if (!readiness) {
        try { readiness = require('../readiness/readinessEngine'); }
        catch { readiness = { recalcForValidation: async () => null }; }
    }
    return readiness;
}

// Which document type is authoritative for which fields, used to assemble the
// cross-document EXPECTED baseline from sibling documents.
const SOURCE_OF_TRUTH = Object.freeze({
    commercial_invoice: ['currency', 'quantity', 'unit_price', 'total_amount', 'tax_amount', 'tax_rate', 'taxable_amount', 'buyer', 'seller'],
    proforma_invoice: ['currency', 'quantity', 'total_amount'],
    packing_list: ['gross_weight', 'net_weight', 'weight_unit', 'package_count', 'quantity'],
    bill_of_lading: ['consignee_address', 'shipper_address', 'consignee', 'shipper', 'port_of_loading', 'port_of_discharge'],
    certificate_of_origin: ['origin_country', 'exporter'],
});

// Three document stores can be validated:
//   tradeops_document — DMS canonical doc (tradeops.documents / TradeDocument) [default]
//   shipment_document — tradeops.shipment_documents / ShipmentDocument
//   document          — legacy trade.documents / Document (INTEGER PK)
const KIND = Object.freeze({
    tradeops_document: 'tradeops_document',
    shipment_document: 'shipment_document',
    document: 'document',
});

function modelFor(kind) {
    if (kind === KIND.tradeops_document) return db.TradeDocument;
    if (kind === KIND.shipment_document) return db.ShipmentDocument;
    if (kind === KIND.document) return db.Document;
    return null;
}

/** The sibling document model for a kind (used for cross-document expected). */
function siblingModelFor(kind) {
    if (kind === KIND.tradeops_document) return db.TradeDocument;
    if (kind === KIND.shipment_document) return db.ShipmentDocument;
    return null; // legacy trade.documents has no first-class operation linkage here
}

/** Read the extracted/parsed fields off a document's metadata, defensively. */
function extractFields(doc) {
    const meta = (doc && (doc.metadata || (doc.get && doc.get('metadata')))) || {};
    return meta.extracted || meta.fields || meta.parsed || {};
}

function operationToExpected(op) {
    if (!op) return {};
    const expected = {};
    if (op.currency) expected.currency = op.currency;
    if (op.origin_country) expected.origin_country = op.origin_country;
    if (op.destination_country) expected.destination_country = op.destination_country;
    if (op.hs_code) expected.hs_code = op.hs_code;
    if (op.commodity) expected.commodity = op.commodity;
    return expected;
}

/** Merge sibling source-of-truth docs into an expected baseline (self excluded). */
function siblingsToExpected(siblings, selfId) {
    const expected = {};
    for (const sib of siblings) {
        if (sib.id === selfId) continue;
        const fields = SOURCE_OF_TRUTH[sib.doc_type];
        if (!fields) continue;
        const ex = extractFields(sib);
        for (const f of fields) {
            if (expected[f] === undefined && ex[f] !== undefined && ex[f] !== null && ex[f] !== '') {
                expected[f] = ex[f];
            }
        }
    }
    return expected;
}

/**
 * Stateless validation of an explicit payload. The pure pipeline.
 *
 * @param {object} input
 * @param {object} input.document   { doc_type, title, id?, ... } header info.
 * @param {object} input.extracted  Fields read off the document.
 * @param {object} [input.expected] Canonical reference values.
 * @param {object} [input.options]  Tolerance overrides for the rules engine.
 * @param {Date}   [input.now]      Injected clock.
 * @returns {Promise<object>} validation_report
 */
async function validatePayload({ document = {}, extracted = {}, expected = {}, options = {}, now = new Date() } = {}) {
    const docType = document.doc_type || null;

    const classification = await aiClassifier.classify({ document, extracted, context: { expected } });
    const { findings: ruleFindings } = rules.run({ extracted, expected, docType, options });

    return report.build({
        document: {
            id: document.id || null,
            doc_type: docType,
            title: document.title || null,
        },
        ruleFindings,
        classification,
        now,
    });
}

/**
 * Load, validate, and persist a validation report for a stored document.
 *
 * @param {object} input
 * @param {string} input.documentId
 * @param {('shipment_document'|'document')} [input.kind='shipment_document']
 * @param {object} [input.expectedOverride]
 * @param {object} [input.options]
 * @param {string} [input.actor]
 * @param {boolean} [input.persist=true]
 * @returns {Promise<{ report: object, record: object|null }>}
 */
async function validateDocument({ documentId, kind = KIND.tradeops_document, expectedOverride = {}, options = {}, actor = null, persist = true, now = new Date() } = {}) {
    const Model = modelFor(kind);
    if (!Model) throw new AppError('INVALID_KIND', `Unknown document kind '${kind}'`, 422, { validKinds: Object.values(KIND) });

    const doc = await Model.findByPk(documentId);
    if (!doc) throw new AppError('NOT_FOUND', 'Document not found', 404);

    // Assemble the EXPECTED reference context from the parent operation and the
    // sibling source-of-truth documents under the same operation/shipment.
    let operation = null;
    let siblings = [];
    const SiblingModel = siblingModelFor(kind);
    if (SiblingModel) {
        const opId = doc.trade_operation_id;
        if (opId) {
            operation = await db.TradeOperation.findByPk(opId);
            siblings = await SiblingModel.findAll({ where: { trade_operation_id: opId } });
        } else if (doc.shipment_id) {
            siblings = await SiblingModel.findAll({ where: { shipment_id: doc.shipment_id } });
        }
    }

    const expected = {
        ...operationToExpected(operation),
        ...(operation && operation.metadata && operation.metadata.expected ? operation.metadata.expected : {}),
        ...siblingsToExpected(siblings, doc.id),
        ...(expectedOverride || {}),
    };

    const extracted = extractFields(doc);
    const document = { id: doc.id, doc_type: doc.doc_type, title: doc.title };

    const validationReport = await validatePayload({ document, extracted, expected, options, now });

    let record = null;
    if (persist) {
        record = await persistReport({ doc, kind, operation, report: validationReport, actor });
        // Event-triggered readiness recalculation (best-effort). A new validation
        // verdict changes the shipment's documentation + risk inputs.
        const shipmentId = doc.shipment_id || null;
        const tradeOperationId = operation ? operation.id : (doc.trade_operation_id || null);
        await readinessEngine().recalcForValidation({ shipmentId, tradeOperationId, tenantId: doc.tenant_id });
    }

    return { report: validationReport, record };
}

/** Persist a validation_report as a DocumentValidation row (if the model exists). */
async function persistReport({ doc, kind, operation, report: r, actor }) {
    if (!db.DocumentValidation) return null; // migration not applied — degrade gracefully
    const sev = r.summary.by_severity;
    return db.DocumentValidation.create({
        tenant_id: doc.tenant_id,
        document_ref: String(doc.id),
        document_kind: kind,
        trade_operation_id: operation ? operation.id : (doc.trade_operation_id || null),
        doc_type: doc.doc_type || (r.classification && r.classification.doc_type) || null,
        status: r.status,
        confidence: r.confidence,
        readiness_score: r.readiness_impact.score,
        readiness_delta: r.readiness_impact.suggested_delta,
        finding_count: r.summary.total,
        critical_count: sev.critical || 0,
        high_count: sev.high || 0,
        medium_count: sev.medium || 0,
        low_count: sev.low || 0,
        engine_version: r.engine_version,
        classification: r.classification || {},
        report: r,
        created_by: actor,
    });
}

module.exports = {
    validatePayload,
    validateDocument,
    SOURCE_OF_TRUTH,
    KIND,
    // exported for tests
    operationToExpected,
    siblingsToExpected,
    extractFields,
};
