'use strict';
/**
 * Trade Operations Dashboard — service layer (War Room 4, Prompt 3).
 *
 * The DB-backed surface behind the dashboard controller. Owns: filtered +
 * paginated shipment listing, merged timeline, readiness computation, document
 * listing and comment append. Pure policy (readiness + rbac) lives in sibling
 * modules; this file is the only one that touches the DB and the cache.
 *
 * TENANT ISOLATION
 * ----------------
 * Every TradeShipment / TradeOperation read runs inside the request's tenant
 * ALS scope, so the model hooks (models/index.js) inject `tenant_id` on the
 * top-level query and DB RLS (migration 009) fail-closes underneath. Because
 * Sequelize fires beforeFind only on the ROOT model, we additionally stamp
 * `tenant_id` on the TradeOperation include for non-bypass callers (defence in
 * depth — the operation is reached via an already-scoped shipment anyway).
 *
 * PARTY SCOPE (RBAC)
 * ------------------
 * On top of tenant isolation, buyer/seller callers are constrained to operations
 * where they are the named party (scope from service/dashboard/rbac.js).
 */
const { Op } = require('sequelize');
const db = require('../../models');
const cache = require('../../cache');
const readiness = require('./readiness');

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
const LIST_TTL = 30;       // seconds
const READINESS_TTL = 30;  // seconds

function clampPagination({ page, limit } = {}) {
    const p = Math.max(1, Number.parseInt(page, 10) || 1);
    const l = Math.min(MAX_LIMIT, Math.max(1, Number.parseInt(limit, 10) || DEFAULT_LIMIT));
    return { page: p, limit: l, offset: (p - 1) * l };
}

// Build the WHERE on the TradeOperation include from party-scope + buyer/seller filters.
function operationWhere({ access, partyOrgIds, buyer, seller, tenantId, bypass }) {
    const where = {};
    if (!bypass && tenantId) where.tenant_id = tenantId;

    // Explicit buyer/seller filters from the query string.
    if (buyer) where.buyer_org_id = buyer;
    if (seller) where.seller_org_id = seller;

    // Party-scope enforcement. buyer/seller callers only see their own party's ops.
    const ids = Array.isArray(partyOrgIds) ? partyOrgIds.filter(Boolean) : [];
    if (access.scope === 'buyer') {
        where.buyer_org_id = ids.length ? { [Op.in]: ids } : '__no_party__';
    } else if (access.scope === 'seller') {
        where.seller_org_id = ids.length ? { [Op.in]: ids } : '__no_party__';
    } else if (access.scope === 'party') {
        // buyer OR seller across the caller's party orgs.
        if (ids.length) {
            where[Op.or] = [{ buyer_org_id: { [Op.in]: ids } }, { seller_org_id: { [Op.in]: ids } }];
        } else {
            where.buyer_org_id = '__no_party__'; // fail-closed: no resolvable party → no rows
        }
    }
    return where;
}

/**
 * Filtered + paginated shipment list for the dashboard.
 * Cached per (tenant, filters, scope, page) for LIST_TTL seconds.
 */
async function listShipments({
    tenantId, bypass = false, access, partyOrgIds = [],
    buyer = null, seller = null, status = null, dateFrom = null, dateTo = null,
    page, limit,
} = {}) {
    const pg = clampPagination({ page, limit });

    const shipmentWhere = {};
    if (status) shipmentWhere.status = Array.isArray(status) ? { [Op.in]: status } : status;
    if (dateFrom || dateTo) {
        shipmentWhere.created_at = {};
        if (dateFrom) shipmentWhere.created_at[Op.gte] = new Date(dateFrom);
        if (dateTo) shipmentWhere.created_at[Op.lte] = new Date(dateTo);
    }

    const opWhere = operationWhere({ access, partyOrgIds, buyer, seller, tenantId, bypass });

    const ck = cache.tkey(tenantId || 'global', 'dash:shipments', JSON.stringify({
        bypass, scope: access.scope, ids: partyOrgIds, buyer, seller, status, dateFrom, dateTo, ...pg,
    }));

    return cache.wrap(ck, LIST_TTL, async () => {
        const { count, rows } = await db.TradeShipment.findAndCountAll({
            where: shipmentWhere,
            include: [{
                model: db.TradeOperation,
                as: 'tradeOperation',
                where: opWhere,
                required: true,
                attributes: ['id', 'reference_no', 'buyer_org_id', 'seller_org_id', 'commodity', 'status', 'priority', 'currency', 'total_value'],
            }],
            limit: pg.limit,
            offset: pg.offset,
            order: [['created_at', 'DESC']],
            distinct: true, // correct count with the required include
        });
        return {
            items: rows.map((s) => s.toJSON()),
            total: count,
            page: pg.page,
            limit: pg.limit,
            pages: Math.ceil(count / pg.limit) || 0,
        };
    });
}

/**
 * Fetch one shipment (+ its operation) enforcing party scope. Returns null when
 * the shipment does not exist OR is outside the caller's party scope — the
 * controller maps both to a 404 so visibility is not leaked.
 */
async function getShipmentScoped(id, { access, partyOrgIds = [] } = {}) {
    const shipment = await db.TradeShipment.findByPk(id, {
        include: [{ model: db.TradeOperation, as: 'tradeOperation' }],
    });
    if (!shipment) return null;
    if (!isOperationInScope(shipment.tradeOperation, access, partyOrgIds)) return null;
    return shipment;
}

function isOperationInScope(operation, access, partyOrgIds = []) {
    if (!operation) return access.scope === 'all'; // orphan shipment: only tenant-wide roles
    if (access.scope === 'all') return true;
    const ids = (partyOrgIds || []).filter(Boolean);
    if (!ids.length) return false; // fail-closed
    if (access.scope === 'buyer') return ids.includes(operation.buyer_org_id);
    if (access.scope === 'seller') return ids.includes(operation.seller_org_id);
    if (access.scope === 'party') return ids.includes(operation.buyer_org_id) || ids.includes(operation.seller_org_id);
    return false;
}

/**
 * Merged, chronologically-ordered timeline for a shipment: tracking events +
 * status-transition history + workflow transitions, normalised to one shape.
 */
async function getTimeline(shipmentId) {
    const [events, history, workflow] = await Promise.all([
        db.ShipmentEvent.findAll({ where: { shipment_id: shipmentId }, order: [['occurred_at', 'ASC']] }),
        db.ShipmentStatusHistory.findAll({ where: { shipment_id: shipmentId }, order: [['changed_at', 'ASC']] }),
        db.ShipmentWorkflow.findOne({ where: { shipment_id: shipmentId } }),
    ]);

    const entries = [];
    for (const e of events) {
        entries.push({
            kind: e.event_type === 'comment' ? 'comment' : 'event',
            at: e.occurred_at,
            title: e.event_type,
            code: e.event_code,
            description: e.description,
            location: e.location_name || e.location_country
                ? { name: e.location_name, country: e.location_country, lat: e.latitude, lng: e.longitude }
                : null,
            source: e.source,
            actor: e.created_by,
            payload: e.payload,
            id: e.id,
        });
    }
    for (const h of history) {
        entries.push({
            kind: 'status_change',
            at: h.changed_at,
            title: `${h.from_status || '∅'} → ${h.to_status}`,
            from: h.from_status,
            to: h.to_status,
            reason: h.reason,
            note: h.note,
            actor: h.changed_by,
            id: h.id,
        });
    }
    if (workflow) {
        const transitions = await db.WorkflowTransition.findAll({
            where: { workflow_id: workflow.id }, order: [['seq', 'ASC']],
        });
        for (const t of transitions) {
            entries.push({
                kind: 'workflow',
                at: t.created_at,
                title: `${t.event}: ${t.from_state || '∅'} → ${t.to_state}`,
                event: t.event,
                from: t.from_state,
                to: t.to_state,
                actor: t.actor,
                id: t.id,
            });
        }
    }

    entries.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    return { shipment_id: shipmentId, count: entries.length, entries };
}

/** Documents for a shipment, filtered by the caller's document visibility. */
async function getDocuments(shipmentId, access, filterFn) {
    const docs = await db.ShipmentDocument.findAll({
        where: { shipment_id: shipmentId }, order: [['created_at', 'DESC']],
    });
    const visible = typeof filterFn === 'function' ? docs.filter((d) => filterFn(access, d.doc_type)) : docs;
    return visible.map((d) => d.toJSON());
}

/** Compute the live readiness score for a shipment (cached READINESS_TTL s). */
async function computeReadiness(shipment, { now = new Date() } = {}) {
    const ck = cache.tkey(shipment.tenant_id || 'global', 'dash:readiness', shipment.id);
    return cache.wrap(ck, READINESS_TTL, async () => {
        const [documents, workflow] = await Promise.all([
            db.ShipmentDocument.findAll({ where: { shipment_id: shipment.id } }),
            db.ShipmentWorkflow.findOne({ where: { shipment_id: shipment.id } }),
        ]);
        return readiness.compute({
            shipment: shipment.toJSON ? shipment.toJSON() : shipment,
            documents: documents.map((d) => d.toJSON()),
            workflowState: workflow ? workflow.current_state : null,
            now,
        });
    });
}

/**
 * Append a comment/chat event to a shipment's timeline. Reuses the append-only
 * ShipmentEvent table (event_type='comment') so comments are first-class
 * timeline entries — no separate table needed. Invalidates the cached timeline
 * + readiness for the shipment.
 */
async function addComment(shipment, { message, actor, visibility = 'all', replyTo = null } = {}) {
    const event = await db.ShipmentEvent.create({
        tenant_id: shipment.tenant_id,
        shipment_id: shipment.id,
        event_type: 'comment',
        event_code: 'CMT',
        description: message,
        occurred_at: new Date(),
        recorded_at: new Date(),
        source: 'manual',
        created_by: actor,
        payload: { message, author: actor, visibility, reply_to: replyTo },
    });
    await invalidateShipment(shipment.tenant_id, shipment.id);
    return event;
}

async function invalidateShipment(tenantId, shipmentId) {
    await Promise.all([
        cache.del(cache.tkey(tenantId || 'global', 'dash:readiness', shipmentId)),
        cache.invalidate(`${tenantId || 'global'}:dash:shipments:*`),
    ]);
}

module.exports = {
    listShipments,
    getShipmentScoped,
    getTimeline,
    getDocuments,
    computeReadiness,
    addComment,
    invalidateShipment,
    isOperationInScope,
    clampPagination,
    MAX_LIMIT,
    DEFAULT_LIMIT,
};
