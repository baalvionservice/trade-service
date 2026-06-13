'use strict';
/**
 * Shipment Readiness Score Engine — PURE scoring core (War Room 4, Prompt 6).
 *
 * This module is PURE: no DB, no I/O, no network. The clock is injected (`now`)
 * so the score is fully deterministic and exhaustively unit-testable. The
 * DB-backed readinessEngine loads the inputs and calls compute() with them.
 *
 * Readiness answers "how close is this shipment to a clean, low-risk hand-off?"
 * as a single 0–100 number plus the four weighted component scores the prompt
 * asks for and the concrete blockers an operator should action.
 *
 * Four weighted components — every one is "higher is better", so the overall
 * readiness_score is just their weighted blend (weights sum to 100):
 *
 *   - documentation (25): verified trade docs vs. the required set.
 *   - compliance    (25): workflow progress along the linear lifecycle.
 *   - logistics     (20): carrier / tracking / routing data completeness.
 *   - risk          (30): a 0–100 SAFETY score (100 = no risk). Danger signals
 *                         — failed/critical document validations, a FAILED or
 *                         retried workflow, a troubled/cancelled shipment, an
 *                         overdue ETA, a sanctions hold, or an uninsured
 *                         high-value consignment — subtract from a perfect 100.
 *
 * A shipment in a hard-failed state (cancelled / exception / workflow FAILED)
 * is clamped so the dashboard never shows a falsely-green score.
 *
 * NOTE on naming: this is a distinct, PERSISTED + CACHED + EVENT-RECALCULATED
 * engine. service/dashboard/readiness.js is the older ephemeral dashboard
 * scorer (documentation/compliance/logistics/SCHEDULE); this engine replaces
 * the schedule component with a first-class RISK component and adds DB
 * snapshots, a cache layer and event-triggered recalculation.
 */

const ENGINE_VERSION = '1.0.0';

// The documents a fully-papered international consignment is expected to carry.
// Presence + `verified` status of each is what the documentation component scores.
const REQUIRED_DOC_TYPES = Object.freeze([
    'commercial_invoice',
    'packing_list',
    'bill_of_lading',
    'certificate_of_origin',
]);

// Component weights. MUST sum to 100.
const WEIGHTS = Object.freeze({
    documentation: 25,
    compliance: 25,
    logistics: 20,
    risk: 30,
});

// Linear lifecycle order used to turn a workflow state into a 0..1 progress
// fraction. Mirrors service/workflow/stateMachine.js happy path. Kept as a local
// constant (not imported) so the scorer stays pure and dependency-free.
const WORKFLOW_ORDER = Object.freeze([
    'CREATED', 'DOCUMENT_COLLECTION', 'DOCUMENT_VERIFICATION', 'COMPLIANCE_CHECK',
    'HS_CLASSIFICATION', 'CUSTOMS_READY', 'FREIGHT_BOOKED', 'DISPATCH_READY',
    'DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED',
]);

// Shipment statuses that represent a hard problem — readiness is capped so a
// stalled/cancelled shipment can never read as "high".
const TROUBLE_STATUSES = Object.freeze(['customs_hold', 'delayed', 'exception']);
const DEAD_STATUSES = Object.freeze(['cancelled']);

// Risk model — penalty weights (0..1) each danger signal contributes to the
// risk component. The summed penalty is clamped to 1, so risk_score = (1-Σ)·100.
const RISK_WEIGHTS = Object.freeze({
    validation_critical: 0.6, // a failed/critical document validation
    validation_high: 0.25, // a high-severity document validation finding
    workflow_failed: 0.8, // workflow is in the FAILED terminal state
    workflow_retry: 0.1, // per document-rejection rework loop (capped)
    workflow_retry_cap: 0.3,
    trouble_status: 0.3, // customs_hold / delayed / exception
    dead_status: 1.0, // cancelled
    overdue_cap: 0.3, // overdue-vs-ETA, scaled over a 7-day window
    sanctions_hold: 0.7, // a compliance / sanctions hold flag on the operation
    uninsured_high_value: 0.2, // high declared value with no bound insurance
});

// Declared value (in the shipment's currency, best-effort) above which a missing
// insurance policy is treated as a material risk.
const HIGH_VALUE_THRESHOLD = 100000;
const OVERDUE_WINDOW_DAYS = 7;

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const clamp01 = (n) => Math.max(0, Math.min(1, n));
const pct = (n) => Math.round(clamp(n) * 100) / 100;

function bandFor(score) {
    if (score >= 80) return 'high';
    if (score >= 50) return 'medium';
    return 'low';
}

/**
 * Documentation readiness: fraction of REQUIRED_DOC_TYPES present AND verified.
 * A present-but-pending/expired doc counts as half credit but flags a blocker;
 * a doc whose latest validation FAILED is treated as unverified.
 */
function scoreDocumentation(documents, failedDocRefs, blockers) {
    const rank = { verified: 3, pending: 2, expired: 1, rejected: 0 };
    const byType = new Map();
    for (const d of documents) {
        // A document whose latest validation failed cannot count as verified.
        const failed = failedDocRefs.has(String(d.id));
        const status = failed && d.status === 'verified' ? 'pending' : d.status;
        const prev = byType.get(d.doc_type);
        if (prev === undefined || (rank[status] ?? 0) > (rank[prev] ?? 0)) {
            byType.set(d.doc_type, status);
        }
    }
    let earned = 0;
    for (const type of REQUIRED_DOC_TYPES) {
        const status = byType.get(type);
        if (status === 'verified') {
            earned += 1;
        } else if (status === 'pending' || status === 'expired') {
            earned += 0.5;
            blockers.push({ component: 'documentation', code: 'DOC_UNVERIFIED', message: `${type} is ${status}` });
        } else {
            blockers.push({ component: 'documentation', code: 'DOC_MISSING', message: `${type} is missing` });
        }
    }
    return earned / REQUIRED_DOC_TYPES.length; // 0..1
}

/** Compliance readiness: progress fraction along the linear workflow lifecycle. */
function scoreCompliance(workflowState, shipmentStatus, blockers) {
    if (workflowState) {
        if (workflowState === 'FAILED') {
            blockers.push({ component: 'compliance', code: 'WORKFLOW_FAILED', message: 'Workflow is in FAILED state' });
            return 0;
        }
        const idx = WORKFLOW_ORDER.indexOf(workflowState);
        if (idx >= 0) {
            const frac = idx / (WORKFLOW_ORDER.length - 1);
            if (idx < WORKFLOW_ORDER.indexOf('COMPLIANCE_CHECK')) {
                blockers.push({ component: 'compliance', code: 'COMPLIANCE_PENDING', message: `Workflow at ${workflowState}; compliance not yet cleared` });
            }
            return frac;
        }
    }
    // No workflow bound → fall back to a coarse mapping off the shipment status.
    const STATUS_PROGRESS = {
        booked: 0.2, picked_up: 0.35, in_transit: 0.6, port_processing: 0.7,
        customs_clearance: 0.75, customs_hold: 0.5, released: 0.85,
        out_for_delivery: 0.9, delivered: 0.97, delayed: 0.5,
        re_routed: 0.55, exception: 0.3, cancelled: 0,
    };
    if (!workflowState) {
        blockers.push({ component: 'compliance', code: 'NO_WORKFLOW', message: 'No workflow bound; compliance inferred from shipment status' });
    }
    return STATUS_PROGRESS[shipmentStatus] ?? 0.2;
}

/** Logistics readiness: completeness of carrier / tracking / routing fields. */
function scoreLogistics(shipment, blockers) {
    const checks = [
        ['carrier', !!(shipment.carrier_id || shipment.carrier_name), 'Carrier not assigned'],
        ['mode', !!shipment.mode, 'Transport mode not set'],
        ['tracking', !!shipment.tracking_number, 'No tracking number'],
        ['origin', !!(shipment.origin_port || shipment.origin_country), 'Origin not set'],
        ['destination', !!(shipment.destination_port || shipment.destination_country), 'Destination not set'],
        ['bol', !!shipment.bill_of_lading_no, 'No bill of lading number'],
    ];
    let earned = 0;
    for (const [, ok, msg] of checks) {
        if (ok) earned += 1;
        else blockers.push({ component: 'logistics', code: 'LOGISTICS_INCOMPLETE', message: msg });
    }
    return earned / checks.length; // 0..1
}

/**
 * Risk SAFETY fraction (1 = no risk, 0 = maximal risk). Aggregates the danger
 * signals; each pushes a `risk` blocker. The summed penalty is clamped to 1.
 *
 * @param {object} input
 * @param {object} input.shipment
 * @param {string|null} input.workflowState
 * @param {object|null} input.workflow            (for retry_count / failure_reason)
 * @param {object} input.validationCounts         { critical, high } across the op's docs
 * @param {boolean} input.sanctionsHold
 * @param {boolean} input.insured
 * @param {Date|number} input.now
 */
function scoreRisk({ shipment, workflowState, workflow, validationCounts, sanctionsHold, insured, now }, blockers) {
    let penalty = 0;

    const crit = Number(validationCounts && validationCounts.critical) || 0;
    const high = Number(validationCounts && validationCounts.high) || 0;
    if (crit > 0) {
        penalty += RISK_WEIGHTS.validation_critical;
        blockers.push({ component: 'risk', code: 'VALIDATION_CRITICAL', message: `${crit} document(s) failed validation with a critical finding` });
    }
    if (high > 0) {
        penalty += Math.min(RISK_WEIGHTS.validation_high * high, RISK_WEIGHTS.validation_high * 2);
        blockers.push({ component: 'risk', code: 'VALIDATION_HIGH', message: `${high} high-severity document validation finding(s)` });
    }

    if (workflowState === 'FAILED') {
        penalty += RISK_WEIGHTS.workflow_failed;
        blockers.push({ component: 'risk', code: 'WORKFLOW_FAILED', message: `Workflow failed${workflow && workflow.failure_reason ? `: ${workflow.failure_reason}` : ''}` });
    }
    const retries = Number(workflow && workflow.retry_count) || 0;
    if (retries > 0) {
        penalty += Math.min(RISK_WEIGHTS.workflow_retry * retries, RISK_WEIGHTS.workflow_retry_cap);
        blockers.push({ component: 'risk', code: 'WORKFLOW_REWORK', message: `Documents reworked ${retries} time(s)` });
    }

    if (DEAD_STATUSES.includes(shipment.status)) {
        penalty += RISK_WEIGHTS.dead_status;
        blockers.push({ component: 'risk', code: 'SHIPMENT_CANCELLED', message: 'Shipment is cancelled' });
    } else if (TROUBLE_STATUSES.includes(shipment.status)) {
        penalty += RISK_WEIGHTS.trouble_status;
        blockers.push({ component: 'risk', code: 'SHIPMENT_TROUBLE', message: `Shipment status is ${shipment.status}` });
    }

    // Overdue vs ETA (only meaningful before delivery).
    if (shipment.status !== 'delivered' && shipment.estimated_arrival) {
        const eta = new Date(shipment.estimated_arrival).getTime();
        const nowMs = now instanceof Date ? now.getTime() : now;
        if (Number.isFinite(eta) && Number.isFinite(nowMs) && nowMs > eta) {
            const overdueDays = (nowMs - eta) / 86400000;
            const p = Math.min(RISK_WEIGHTS.overdue_cap, (overdueDays / OVERDUE_WINDOW_DAYS) * RISK_WEIGHTS.overdue_cap);
            penalty += p;
            blockers.push({ component: 'risk', code: 'OVERDUE', message: `Past ETA by ${overdueDays.toFixed(1)} day(s)` });
        }
    }

    if (sanctionsHold) {
        penalty += RISK_WEIGHTS.sanctions_hold;
        blockers.push({ component: 'risk', code: 'SANCTIONS_HOLD', message: 'A sanctions / compliance hold is flagged on this operation' });
    }

    const declaredValue = Number(shipment.declared_value) || 0;
    if (declaredValue >= HIGH_VALUE_THRESHOLD && !insured) {
        penalty += RISK_WEIGHTS.uninsured_high_value;
        blockers.push({ component: 'risk', code: 'UNINSURED_HIGH_VALUE', message: `High-value consignment (${declaredValue}) has no bound insurance policy` });
    }

    return clamp01(1 - penalty); // 0..1 safety
}

/**
 * Compute the full readiness score.
 *
 * @param {object} input
 * @param {object} input.shipment                 TradeShipment (plain object / instance).
 * @param {Array}  [input.documents=[]]           ShipmentDocument rows.
 * @param {string} [input.workflowState=null]     Current ShipmentWorkflow state.
 * @param {object} [input.workflow=null]          ShipmentWorkflow (retry_count / failure_reason).
 * @param {Array}  [input.validations=[]]         Latest DocumentValidation rows for the op/shipment.
 * @param {boolean}[input.sanctionsHold=false]    Compliance / sanctions hold flag.
 * @param {boolean}[input.insured=false]          A bound insurance policy exists.
 * @param {Date|number} [input.now=new Date()]    Injected clock for determinism.
 * @returns {object} readiness snapshot
 */
function compute({
    shipment, documents = [], workflowState = null, workflow = null,
    validations = [], sanctionsHold = false, insured = false, now = new Date(),
} = {}) {
    if (!shipment) {
        return {
            readiness_score: 0,
            compliance_score: 0,
            documentation_score: 0,
            logistics_score: 0,
            risk_score: 0,
            band: 'low',
            weights: WEIGHTS,
            components: {},
            blockers: [{ component: 'shipment', code: 'NOT_FOUND', message: 'No shipment' }],
            capped: true,
            engine_version: ENGINE_VERSION,
        };
    }

    const blockers = [];

    // Fold the latest validations into: failed-doc set (documentation downgrade)
    // + critical/high counts (risk). One row per document is assumed (caller
    // passes the LATEST validation per document).
    const failedDocRefs = new Set();
    let validationCritical = 0;
    let validationHigh = 0;
    for (const v of validations) {
        // Only a FAILED verdict feeds the risk penalty. A passed / passed_with_warnings
        // document has no high/critical findings worth gating readiness on (per the
        // validation engine, any HIGH/CRITICAL finding makes the verdict 'failed').
        if (v.status === 'failed') {
            if (v.document_ref != null) failedDocRefs.add(String(v.document_ref));
            validationCritical += Number(v.critical_count) || 0;
            validationHigh += Number(v.high_count) || 0;
        }
    }
    const validationCounts = { critical: validationCritical, high: validationHigh };

    const documentation = scoreDocumentation(documents, failedDocRefs, blockers);
    const compliance = scoreCompliance(workflowState, shipment.status, blockers);
    const logistics = scoreLogistics(shipment, blockers);
    const risk = scoreRisk({ shipment, workflowState, workflow, validationCounts, sanctionsHold, insured, now }, blockers);

    const raw =
        documentation * WEIGHTS.documentation +
        compliance * WEIGHTS.compliance +
        logistics * WEIGHTS.logistics +
        risk * WEIGHTS.risk;

    let score = clamp(raw);
    let capped = false;

    // Hard-problem clamps so a troubled shipment can never read green.
    if (DEAD_STATUSES.includes(shipment.status) || workflowState === 'FAILED') {
        score = Math.min(score, 10);
        capped = true;
    } else if (TROUBLE_STATUSES.includes(shipment.status)) {
        score = Math.min(score, 60);
        capped = true;
    }

    return {
        readiness_score: pct(score),
        compliance_score: pct(compliance * 100),
        documentation_score: pct(documentation * 100),
        logistics_score: pct(logistics * 100),
        risk_score: pct(risk * 100),
        band: bandFor(score),
        weights: WEIGHTS,
        components: {
            documentation: pct(documentation * 100),
            compliance: pct(compliance * 100),
            logistics: pct(logistics * 100),
            risk: pct(risk * 100),
        },
        blockers,
        capped,
        engine_version: ENGINE_VERSION,
    };
}

module.exports = {
    compute,
    bandFor,
    scoreDocumentation,
    scoreCompliance,
    scoreLogistics,
    scoreRisk,
    REQUIRED_DOC_TYPES,
    WEIGHTS,
    WORKFLOW_ORDER,
    RISK_WEIGHTS,
    HIGH_VALUE_THRESHOLD,
    TROUBLE_STATUSES,
    DEAD_STATUSES,
    ENGINE_VERSION,
};
