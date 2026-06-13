'use strict';
/**
 * Shipment Readiness Score Engine — DB-backed ORCHESTRATOR (War Room 4, Prompt 6).
 *
 * Wraps the PURE scoring core (scoring.js) with the three things the prompt asks
 * for that a pure function deliberately avoids:
 *
 *   • DB persistence  — every recalculation INSERTs an append-only snapshot into
 *                       tradeops.shipment_readiness_scores (the latest row is the
 *                       live score; the history is a real-time trend / audit).
 *   • Caching layer   — the latest score is cached per (tenant, shipment) so the
 *                       hot read path never touches the DB; the cache is busted +
 *                       refreshed on every recalculation (real-time updates).
 *   • Event-triggered — recalculation is driven by events: a workflow transition,
 *     recalculation    a document validation, a shipment status change, or an
 *                       explicit API call. triggerRecalc() is the fire-and-forget
 *                       hook the other engines call post-commit (never throws into
 *                       their request path).
 *
 * INPUT ASSEMBLY
 * --------------
 * For a shipment we load: its parent operation, its documents, its workflow, the
 * LATEST document-validation per document (best-effort — the validations table is
 * a sibling engine that may not be migrated), and an insurance/sanctions signal
 * derived from operation/shipment metadata. These feed scoring.compute().
 */

const db = require('../../models');
const cache = require('../../cache');
const scoring = require('./scoring');
const { AppError } = require('../../utils/errors');

const CACHE_NS = 'readiness:latest';
const CACHE_TTL = 60; // seconds

const cacheKey = (tenantId, shipmentId) => cache.tkey(tenantId || 'global', CACHE_NS, shipmentId);

/** Plain-object view of a Sequelize instance (or pass-through for a POJO). */
const plain = (x) => (x && typeof x.toJSON === 'function' ? x.toJSON() : x);

/**
 * Latest document-validation per document for an operation/shipment. Best-effort:
 * the validations table (migration 011) is an independent engine and may not be
 * applied — degrade to [] rather than failing the readiness computation.
 */
async function loadLatestValidations({ tradeOperationId, documentRefs }) {
    if (!db.DocumentValidation) return [];
    try {
        const where = {};
        if (tradeOperationId) {
            where.trade_operation_id = tradeOperationId;
        } else if (Array.isArray(documentRefs) && documentRefs.length) {
            where.document_ref = documentRefs.map(String);
        } else {
            return [];
        }
        // Bound the scan — we only keep the LATEST row per document, and the newest
        // validations dominate the risk read. A generous cap protects a hot recalc
        // from an operation with a deep validation history.
        const rows = await db.DocumentValidation.findAll({
            where, order: [['created_at', 'DESC']], limit: 250,
        });
        // Keep only the newest validation per document_ref.
        const seen = new Set();
        const latest = [];
        for (const r of rows) {
            const ref = String(r.document_ref);
            if (seen.has(ref)) continue;
            seen.add(ref);
            latest.push(plain(r));
        }
        return latest;
    } catch {
        return []; // table missing / not migrated — degrade gracefully
    }
}

/** Whether a bound insurance policy covers this shipment (metadata + best-effort model). */
async function resolveInsured({ shipment, operation }) {
    const meta = (shipment && shipment.metadata) || {};
    const opMeta = (operation && operation.metadata) || {};
    if (meta.insured === true || (opMeta.insurance && opMeta.insurance.bound === true)) return true;
    if (!db.InsurancePolicy) return false;
    try {
        const count = await db.InsurancePolicy.count({ where: { shipment_id: shipment.id } });
        return count > 0;
    } catch {
        return false; // model/column mismatch — fall back to metadata signal only
    }
}

/** Derive a sanctions / compliance hold flag from operation + shipment signals. */
function resolveSanctionsHold({ shipment, operation }) {
    const meta = (shipment && shipment.metadata) || {};
    const opMeta = (operation && operation.metadata) || {};
    return !!(
        meta.sanctions_hold ||
        opMeta.sanctions_hold ||
        (opMeta.compliance && (opMeta.compliance.hold || opMeta.compliance.sanctions_hold)) ||
        (operation && operation.status === 'on_hold')
    );
}

/**
 * Assemble every input the pure scorer needs for a shipment instance.
 * @param {object} shipment Sequelize TradeShipment (or POJO with an id).
 */
async function assembleInputs(shipment, { now = new Date() } = {}) {
    const shipmentId = shipment.id;
    const operationId = shipment.trade_operation_id || null;

    const [operation, documents, workflow] = await Promise.all([
        operationId ? db.TradeOperation.findByPk(operationId) : Promise.resolve(null),
        db.ShipmentDocument.findAll({ where: { shipment_id: shipmentId } }),
        db.ShipmentWorkflow.findOne({ where: { shipment_id: shipmentId } }),
    ]);

    const documentRefs = documents.map((d) => d.id);
    const [validations, insured] = await Promise.all([
        loadLatestValidations({ tradeOperationId: operationId, documentRefs }),
        resolveInsured({ shipment: plain(shipment), operation: plain(operation) }),
    ]);

    return {
        shipment: plain(shipment),
        operation: plain(operation),
        workflow: plain(workflow),
        documents: documents.map(plain),
        validations,
        insured,
        sanctionsHold: resolveSanctionsHold({ shipment: plain(shipment), operation: plain(operation) }),
        workflowState: workflow ? workflow.current_state : null,
        now,
    };
}

/** Run the pure scorer over assembled inputs → a readiness snapshot object. */
function score(inputs) {
    return scoring.compute({
        shipment: inputs.shipment,
        documents: inputs.documents,
        workflowState: inputs.workflowState,
        workflow: inputs.workflow,
        validations: inputs.validations,
        sanctionsHold: inputs.sanctionsHold,
        insured: inputs.insured,
        now: inputs.now,
    });
}

/** Persist a snapshot row from a computed score + its inputs. */
async function persistSnapshot({ inputs, snapshot, trigger, reason, actor }) {
    return db.ShipmentReadiness.create({
        tenant_id: inputs.shipment.tenant_id,
        shipment_id: inputs.shipment.id,
        trade_operation_id: inputs.shipment.trade_operation_id || null,
        workflow_id: inputs.workflow ? inputs.workflow.id : null,
        readiness_score: snapshot.readiness_score,
        compliance_score: snapshot.compliance_score,
        documentation_score: snapshot.documentation_score,
        logistics_score: snapshot.logistics_score,
        risk_score: snapshot.risk_score,
        band: snapshot.band,
        capped: snapshot.capped,
        weights: snapshot.weights,
        components: snapshot.components,
        blockers: snapshot.blockers,
        blocker_count: snapshot.blockers.length,
        engine_version: snapshot.engine_version,
        trigger: trigger || 'manual',
        reason: reason || null,
        created_by: actor || null,
    });
}

/** Normalize a snapshot (fresh or persisted) into the stable API view shape. */
function toView(snapshot, { record = null, computedAt = null } = {}) {
    return {
        shipment_id: record ? record.shipment_id : snapshot.shipment_id,
        readiness_score: snapshot.readiness_score,
        compliance_score: snapshot.compliance_score,
        documentation_score: snapshot.documentation_score,
        logistics_score: snapshot.logistics_score,
        risk_score: snapshot.risk_score,
        band: snapshot.band,
        capped: snapshot.capped,
        weights: snapshot.weights,
        components: snapshot.components,
        blockers: snapshot.blockers,
        blocker_count: Array.isArray(snapshot.blockers) ? snapshot.blockers.length : 0,
        engine_version: snapshot.engine_version,
        trigger: record ? record.trigger : (snapshot.trigger || null),
        snapshot_id: record ? record.id : null,
        computed_at: record ? record.created_at : (computedAt || null),
        persisted: !!record,
    };
}

/**
 * Recalculate (and persist + cache) the readiness score for a shipment.
 * The authoritative write path — every event-driven recalculation lands here.
 *
 * @param {string} shipmentId
 * @param {object} opts { trigger, reason, actor, now, persist }
 * @returns {Promise<{ snapshot, record, view }>}
 */
async function recalculate(shipmentId, { trigger = 'manual', reason = null, actor = null, now = new Date(), persist = true, tenantId = null } = {}) {
    // Defence in depth: the event-triggered path (workflow / validation hooks) has
    // no request ALS context, so the Sequelize tenant hook is a no-op there. When a
    // caller knows the expected tenant, scope the lookup explicitly (RLS is the
    // ultimate backstop).
    const where = { id: shipmentId };
    if (tenantId) where.tenant_id = tenantId;
    const shipment = await db.TradeShipment.findOne({ where });
    if (!shipment) throw new AppError('NOT_FOUND', 'Shipment not found', 404);

    const inputs = await assembleInputs(shipment, { now });
    const snapshot = score(inputs);

    let record = null;
    if (persist) {
        record = await persistSnapshot({ inputs, snapshot, trigger, reason, actor });
    }

    const view = toView(snapshot, { record, computedAt: now instanceof Date ? now.toISOString() : new Date(now).toISOString() });
    // Real-time update: refresh the cache with the just-computed live score.
    await cache.set(cacheKey(shipment.tenant_id, shipment.id), view, CACHE_TTL);
    return { snapshot, record, view };
}

/**
 * The live readiness score for a shipment (cache-aside). On a cache + DB miss the
 * score is computed fresh and persisted so the first read seeds the time series.
 *
 * @param {object} shipment Sequelize TradeShipment (already tenant-scoped/owned).
 */
async function getLatest(shipment, { now = new Date() } = {}) {
    const ck = cacheKey(shipment.tenant_id, shipment.id);
    const cached = await cache.get(ck);
    if (cached) return cached;

    const latest = await db.ShipmentReadiness.findOne({
        where: { shipment_id: shipment.id },
        order: [['created_at', 'DESC']],
    });
    if (latest) {
        const view = toView({
            readiness_score: Number(latest.readiness_score),
            compliance_score: Number(latest.compliance_score),
            documentation_score: Number(latest.documentation_score),
            logistics_score: Number(latest.logistics_score),
            risk_score: Number(latest.risk_score),
            band: latest.band,
            capped: latest.capped,
            weights: latest.weights,
            components: latest.components,
            blockers: latest.blockers,
            engine_version: latest.engine_version,
        }, { record: latest });
        await cache.set(ck, view, CACHE_TTL);
        return view;
    }

    // No snapshot yet — seed one.
    const { view } = await recalculate(shipment.id, { trigger: 'api', reason: 'first-read seed', now });
    return view;
}

/** Paginated snapshot history (newest first) for a shipment. */
async function listHistory(shipmentId, { page = 1, limit = 20, tenantId = null } = {}) {
    const p = Math.max(1, Number.parseInt(page, 10) || 1);
    const l = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));
    const where = { shipment_id: shipmentId };
    if (tenantId) where.tenant_id = tenantId; // defence in depth over the tenant hook + RLS
    const { count, rows } = await db.ShipmentReadiness.findAndCountAll({
        where,
        order: [['created_at', 'DESC']],
        limit: l,
        offset: (p - 1) * l,
    });
    return { items: rows, total: count, page: p, limit: l, pages: Math.ceil(count / l) || 0 };
}

// ── Event-triggered recalculation hooks (fire-and-forget) ────────────────────

/**
 * Best-effort recalculation for a single shipment. NEVER throws — it is called
 * from the post-commit path of other engines (workflow / validation), so a
 * readiness failure must not roll back or break their request.
 */
async function triggerRecalc(shipmentId, { trigger = 'shipment_status', reason = null, actor = 'system', tenantId = null } = {}) {
    if (!shipmentId) return null;
    try {
        return await recalculate(shipmentId, { trigger, reason, actor, tenantId });
    } catch (err) {
        // Swallow — the live score is recoverable on the next read/recalc.
        if (process.env.NODE_ENV === 'development') {
            // eslint-disable-next-line no-console
            console.warn('[readiness] recalc failed for', shipmentId, '-', err && err.message);
        }
        return null;
    }
}

/** Recalculate readiness for every shipment under a trade operation (best-effort). */
async function recalcForOperation(tradeOperationId, opts = {}) {
    if (!tradeOperationId) return { recalculated: 0 };
    let shipments = [];
    try {
        const where = { trade_operation_id: tradeOperationId };
        if (opts.tenantId) where.tenant_id = opts.tenantId;
        shipments = await db.TradeShipment.findAll({ where, attributes: ['id'] });
    } catch {
        return { recalculated: 0 };
    }
    // Fan out in parallel — triggerRecalc is already best-effort (never rejects).
    const results = await Promise.allSettled(shipments.map((s) => triggerRecalc(s.id, opts)));
    const recalculated = results.filter((r) => r.status === 'fulfilled' && r.value).length;
    return { recalculated };
}

/**
 * Resolve the affected shipment(s) for a document-validation event and recompute.
 * A shipment_document carries shipment_id directly; otherwise we fan out across
 * the operation's shipments.
 */
async function recalcForValidation({ shipmentId = null, tradeOperationId = null, tenantId = null } = {}) {
    const base = { trigger: 'document_validation', reason: 'document validated', tenantId };
    if (shipmentId) {
        await triggerRecalc(shipmentId, base);
        return { recalculated: 1 };
    }
    if (tradeOperationId) {
        return recalcForOperation(tradeOperationId, base);
    }
    return { recalculated: 0 };
}

module.exports = {
    recalculate,
    getLatest,
    listHistory,
    triggerRecalc,
    recalcForOperation,
    recalcForValidation,
    // exported for tests / reuse
    assembleInputs,
    score,
    toView,
    CACHE_NS,
    CACHE_TTL,
    cacheKey,
};
