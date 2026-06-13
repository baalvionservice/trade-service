'use strict';
/**
 * Trade Operations Dashboard — shipment READINESS SCORE (War Room 4, Prompt 3).
 *
 * This module is PURE: no DB, no I/O, no network. The clock is injected (`now`)
 * so the score is fully deterministic and exhaustively unit-testable. The
 * DB-backed dashboardService loads the inputs and calls compute() with them.
 *
 * Readiness answers "how close is this shipment to a clean, on-time hand-off?"
 * as a single 0–100 number plus the component breakdown and the concrete
 * blockers a buyer/seller/bank operator should action.
 *
 * Four weighted components (weights sum to 100):
 *   - documentation (30): verified trade docs vs. the required set.
 *   - compliance    (25): workflow progress along the linear lifecycle.
 *   - logistics     (25): carrier / tracking / routing data completeness.
 *   - schedule      (20): on-time vs. delayed against the ETA.
 *
 * A shipment in a hard-failed state (cancelled / exception / workflow FAILED)
 * is clamped so the dashboard never shows a falsely-green score.
 */

// The documents a fully-papered international consignment is expected to carry.
// Presence + `verified` status of each is what the documentation component scores.
const REQUIRED_DOC_TYPES = Object.freeze([
    'commercial_invoice',
    'packing_list',
    'bill_of_lading',
    'certificate_of_origin',
]);

const WEIGHTS = Object.freeze({
    documentation: 30,
    compliance: 25,
    logistics: 25,
    schedule: 20,
});

// Linear lifecycle order used to turn a workflow state into a 0..1 progress
// fraction. Mirrors service/workflow/stateMachine.js happy path. Kept as a local
// constant (not imported) so the scorer stays pure and dependency-free.
const WORKFLOW_ORDER = Object.freeze([
    'CREATED', 'DOCUMENT_COLLECTION', 'DOCUMENT_VERIFICATION', 'COMPLIANCE_CHECK',
    'HS_CLASSIFICATION', 'CUSTOMS_READY', 'FREIGHT_BOOKED', 'DISPATCH_READY',
    'DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED',
]);

// Shipment statuses that represent a hard problem — the score is capped so a
// stalled/cancelled shipment can never read as "high" readiness.
const TROUBLE_STATUSES = Object.freeze(['customs_hold', 'delayed', 'exception']);
const DEAD_STATUSES = Object.freeze(['cancelled']);

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const pct = (n) => Math.round(clamp(n) * 100) / 100;

function bandFor(score) {
    if (score >= 80) return 'high';
    if (score >= 50) return 'medium';
    return 'low';
}

/**
 * Documentation readiness: fraction of REQUIRED_DOC_TYPES present AND verified.
 * A present-but-pending/rejected/expired doc counts as present (half credit)
 * but flags a blocker.
 */
function scoreDocumentation(documents, blockers) {
    const byType = new Map();
    for (const d of documents) {
        // Keep the "best" status seen per type (verified beats pending beats rejected).
        const rank = { verified: 3, pending: 2, expired: 1, rejected: 0 };
        const prev = byType.get(d.doc_type);
        if (prev === undefined || (rank[d.status] ?? 0) > (rank[prev] ?? 0)) {
            byType.set(d.doc_type, d.status);
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
        const idx = WORKFLOW_ORDER.indexOf(workflowState);
        if (idx >= 0) {
            const frac = idx / (WORKFLOW_ORDER.length - 1);
            if (idx < WORKFLOW_ORDER.indexOf('COMPLIANCE_CHECK')) {
                blockers.push({ component: 'compliance', code: 'COMPLIANCE_PENDING', message: `Workflow at ${workflowState}; compliance not yet cleared` });
            }
            return frac;
        }
        if (workflowState === 'FAILED') {
            blockers.push({ component: 'compliance', code: 'WORKFLOW_FAILED', message: 'Workflow is in FAILED state' });
            return 0;
        }
    }
    // No workflow bound → fall back to a coarse mapping off the shipment status.
    const STATUS_PROGRESS = {
        booked: 0.2, picked_up: 0.35, in_transit: 0.6, port_processing: 0.7,
        customs_clearance: 0.75, customs_hold: 0.5, released: 0.85,
        out_for_delivery: 0.9, delivered: 0.97, delayed: 0.5,
        re_routed: 0.55, exception: 0.3, cancelled: 0,
    };
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
 * Schedule readiness: on-time health against the ETA.
 *  - delivered already → 1.
 *  - no ETA → neutral 0.5 (unknown, not penalised to zero).
 *  - arrived/arriving on time → 1, sliding down to 0 as it runs past ETA.
 */
function scoreSchedule(shipment, now, blockers) {
    if (shipment.status === 'delivered' && shipment.actual_arrival) return 1;
    const eta = shipment.estimated_arrival ? new Date(shipment.estimated_arrival).getTime() : null;
    if (!eta || Number.isNaN(eta)) {
        blockers.push({ component: 'schedule', code: 'NO_ETA', message: 'No estimated arrival on record' });
        return 0.5;
    }
    const nowMs = now instanceof Date ? now.getTime() : now;
    if (nowMs <= eta) return 1; // on or ahead of schedule
    // Past ETA: degrade linearly over a 7-day grace window.
    const overdueDays = (nowMs - eta) / 86400000;
    blockers.push({ component: 'schedule', code: 'OVERDUE', message: `Past ETA by ${overdueDays.toFixed(1)} day(s)` });
    return clamp(1 - overdueDays / 7, 0, 1);
}

/**
 * Compute the readiness score.
 *
 * @param {object} input
 * @param {object} input.shipment   TradeShipment (plain object / Sequelize instance).
 * @param {Array}  [input.documents=[]]  ShipmentDocument rows.
 * @param {string} [input.workflowState] Current ShipmentWorkflow state, if any.
 * @param {Date|number} [input.now=new Date()] Injected clock for determinism.
 * @returns {{score:number, band:string, components:object, weights:object, blockers:Array, capped:boolean}}
 */
function compute({ shipment, documents = [], workflowState = null, now = new Date() } = {}) {
    if (!shipment) {
        return { score: 0, band: 'low', components: {}, weights: WEIGHTS, blockers: [{ component: 'shipment', code: 'NOT_FOUND', message: 'No shipment' }], capped: true };
    }
    const blockers = [];

    const documentation = scoreDocumentation(documents, blockers);
    const compliance = scoreCompliance(workflowState, shipment.status, blockers);
    const logistics = scoreLogistics(shipment, blockers);
    const schedule = scoreSchedule(shipment, now, blockers);

    const raw =
        documentation * WEIGHTS.documentation +
        compliance * WEIGHTS.compliance +
        logistics * WEIGHTS.logistics +
        schedule * WEIGHTS.schedule;

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
        score: pct(score),
        band: bandFor(score),
        components: {
            documentation: pct(documentation * 100),
            compliance: pct(compliance * 100),
            logistics: pct(logistics * 100),
            schedule: pct(schedule * 100),
        },
        weights: WEIGHTS,
        blockers,
        capped,
    };
}

module.exports = {
    compute,
    bandFor,
    REQUIRED_DOC_TYPES,
    WEIGHTS,
    WORKFLOW_ORDER,
};
