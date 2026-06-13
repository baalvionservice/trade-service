'use strict';
/**
 * Compliance AI Agent — DB-backed ORCHESTRATOR (War Room 4, Prompt 13).
 *
 * Wires the PURE layers (signals → ruleAnalyzer → aiAnalyzer → fusion → explain)
 * to the persistence and context-loading they deliberately avoid:
 *
 *   • assess()          — STATELESS. Scan a raw subject/shipment payload, run the
 *                         rule layer (reusing the Prompt 8 reference data + the
 *                         caller's tenant blacklist/whitelist + KYC/AML hooks) and
 *                         the AI layer, fuse + explain. No DB write.
 *
 *   • assessShipment()  — load a tradeops shipment (+ its trade operation) for
 *                         context, scan + assess it, and PERSIST an append-only
 *                         compliance_assessment snapshot, refreshing the cache.
 *
 *   • getLatest()       — the live, cached assessment for a shipment (cache-aside;
 *                         seeds one on first read).
 *
 *   • triggerAssess()   — fire-and-forget event hook (e.g. workflow compliance
 *                         transition / dispatch gate). NEVER throws into the caller.
 *
 * REFERENCE DATA + tenant lists are loaded via the Prompt 8 compliance engine so
 * the rule half of the hybrid shares one source of truth with the standalone
 * sanctions screening.
 */

const db = require('../../models');
const cache = require('../../cache');
const logger = require('../logger');
const complianceEngine = require('../compliance/complianceEngine');
const kycAml = require('../compliance/kycAml');
const { AppError } = require('../../utils/errors');

const signals = require('./signals');
const ruleAnalyzer = require('./ruleAnalyzer');
const aiAnalyzer = require('./aiAnalyzer');
const fusion = require('./fusion');
const explain = require('./explain');
const { RISK_CATEGORY } = require('./schema');

const ENGINE_VERSION = '1.0.0';
const LATEST_NS = 'compliance_agent:latest';
const LATEST_TTL = 60;

const latestKey = (tenantId, shipmentId) => cache.tkey(tenantId || 'global', LATEST_NS, shipmentId);
const plain = (x) => (x && typeof x.toJSON === 'function' ? x.toJSON() : x);

/**
 * Run the full agent pipeline against an already-scanned subject.
 * PURE-ish: takes loaded context (refData/tenantLists/hooks) and composes the
 * layers. No DB. Returns the `compliance_assessment` report object.
 */
function compose({ scan, refData, tenantLists, hooks }) {
    const ruleResult = ruleAnalyzer.analyze({ subject: scan.subject, refData, tenantLists, hooks });
    return aiAnalyzer.analyze({ subject: scan.subject, signals: scan.signals })
        .then((aiResult) => {
            const dataGap = ruleResult.findings.concat(aiResult.findings)
                .some((f) => f.category === RISK_CATEGORY.DOCUMENTATION_GAP)
                || scan.signals.some((s) => ['no_parties', 'party_no_name', 'value_missing'].includes(s.code));

            const fused = fusion.fuse({
                ruleFindings: ruleResult.findings,
                aiFindings: aiResult.findings,
                dataGap,
            });
            const explanation = explain.build({ scan, ruleSteps: ruleResult.steps, ai: aiResult, fusion: fused });

            return {
                engine_version: ENGINE_VERSION,
                model: { rule: 'compliance-rules@8', ai: aiResult.provider, degraded: !!aiResult.degraded },
                scanned_at: scan.scanned_at,
                subject: {
                    origin_country: scan.subject.originCountry,
                    destination_country: scan.subject.destinationCountry,
                    direction: scan.subject.direction,
                    total_value: scan.subject.totalValue,
                    currency: scan.subject.currency,
                    parties: scan.subject.parties,
                    goods: scan.subject.goods,
                    route: scan.subject.route,
                },
                signals: scan.signals,
                decision: fused.decision,
                risk_score: fused.risk_score,
                risk_level: fused.risk_level,
                severity: fused.severity,
                blocking: fused.blocking,
                confidence: fused.confidence,
                confidence_band: fused.confidence_band,
                finding_count: fused.finding_count,
                counts: fused.counts,
                by_source: fused.by_source,
                by_category: fused.by_category,
                top_risks: fused.top_risks,
                findings: fused.findings,
                explanation,
            };
        });
}

/** Load reference data + tenant lists + run KYC/AML hooks for a subject. */
async function loadContext(subject, { tenantId, runHooks = true, now = new Date() }) {
    const [refData, tenantLists] = await Promise.all([
        complianceEngine.loadReferenceData(),
        complianceEngine.loadTenantLists(tenantId, { now }),
    ]);
    const hooks = runHooks ? await kycAml.screen(subject) : null;
    return { refData, tenantLists, hooks };
}

// ── Public: stateless assessment ─────────────────────────────────────────────

/**
 * Stateless compliance assessment of an arbitrary shipment/subject payload.
 * No DB write.
 *
 * @param {object} input  { shipment?, operation?, ...subject fields }
 * @param {object} [opts] { tenantId, runHooks=true, now }
 * @returns {Promise<object>} compliance_assessment report
 */
async function assess(input = {}, { tenantId = null, runHooks = true, now = new Date() } = {}) {
    const scan = signals.scan({
        shipment: input.shipment || input,
        operation: input.operation || {},
        overrides: input.overrides || {},
        now,
    });
    const effectiveTenant = tenantId || input.tenantId || null;
    const ctx = await loadContext(scan.subject, { tenantId: effectiveTenant, runHooks, now });
    return compose({ scan, ...ctx });
}

// ── Public: persisted shipment assessment ────────────────────────────────────

/** Persist a compliance_assessment report as a ComplianceAssessment row. */
async function persistAssessment({ tenantId, shipment, operation, report, trigger, reason, actor }) {
    return db.ComplianceAssessment.create({
        tenant_id: tenantId,
        shipment_id: shipment ? shipment.id : null,
        trade_operation_id: operation ? operation.id : (shipment ? shipment.trade_operation_id : null),
        subject_ref: shipment ? shipment.shipment_no : null,
        decision: report.decision,
        risk_score: report.risk_score,
        risk_level: report.risk_level,
        severity: report.severity,
        confidence: report.confidence,
        blocking: report.blocking,
        finding_count: report.finding_count,
        rule_finding_count: report.by_source.rule + report.by_source.hybrid,
        ai_finding_count: report.by_source.ai,
        origin_country: report.subject.origin_country || null,
        destination_country: report.subject.destination_country || null,
        top_risks: report.top_risks || [],
        findings: report.findings || [],
        reasoning: report.explanation.reasoning || [],
        narrative: report.explanation.narrative || null,
        signals: report.signals || [],
        report,
        model_provider: report.model.ai,
        engine_version: report.engine_version,
        trigger: trigger || 'manual',
        reason: reason || null,
        created_by: actor || null,
    });
}

/** Normalize a report (+ optional persisted row) into the API view shape. */
function toView(report, { record = null } = {}) {
    return {
        assessment_id: record ? record.id : null,
        shipment_id: record ? record.shipment_id : null,
        trade_operation_id: record ? record.trade_operation_id : null,
        decision: report.decision,
        risk_score: report.risk_score,
        risk_level: report.risk_level,
        severity: report.severity,
        blocking: report.blocking,
        confidence: report.confidence,
        confidence_band: report.confidence_band,
        finding_count: report.finding_count,
        by_source: report.by_source,
        by_category: report.by_category,
        top_risks: report.top_risks,
        findings: report.findings,
        explanation: report.explanation,
        signals: report.signals,
        subject: report.subject,
        model: report.model,
        engine_version: report.engine_version,
        trigger: record ? record.trigger : null,
        assessed_at: record ? record.created_at : report.scanned_at,
        persisted: !!record,
    };
}

/**
 * Assess a tradeops shipment in-context and PERSIST the result.
 *
 * @param {string} shipmentId
 * @param {object} opts { overrides, trigger, reason, actor, tenantId, runHooks, persist, now }
 * @returns {Promise<{ report, record, view }>}
 */
async function assessShipment(shipmentId, {
    overrides = {}, trigger = 'manual', reason = null, actor = null,
    tenantId = null, runHooks = true, persist = true, now = new Date(),
} = {}) {
    const where = { id: shipmentId };
    if (tenantId) where.tenant_id = tenantId; // defence in depth over the tenant hook + RLS
    const shipment = await db.TradeShipment.findOne({ where });
    if (!shipment) throw new AppError('NOT_FOUND', 'Shipment not found', 404);

    const operation = shipment.trade_operation_id
        ? await db.TradeOperation.findByPk(shipment.trade_operation_id)
        : null;

    const effectiveTenant = tenantId || shipment.tenant_id;
    const scan = signals.scan({ shipment: plain(shipment), operation: plain(operation) || {}, overrides, now });
    const ctx = await loadContext(scan.subject, { tenantId: effectiveTenant, runHooks, now });
    const report = await compose({ scan, ...ctx });

    let record = null;
    if (persist) {
        record = await persistAssessment({
            tenantId: effectiveTenant, shipment: plain(shipment), operation: plain(operation),
            report, trigger, reason, actor,
        });
    }
    const view = toView(report, { record });
    await cache.set(latestKey(effectiveTenant, shipment.id), view, LATEST_TTL);
    return { report, record, view };
}

/** The live, cached latest assessment for a shipment (seeds one on first read). */
async function getLatest(shipment, { now = new Date() } = {}) {
    const s = plain(shipment);
    const ck = latestKey(s.tenant_id, s.id);
    const cached = await cache.get(ck);
    if (cached) return cached;

    const where = { shipment_id: s.id };
    if (s.tenant_id) where.tenant_id = s.tenant_id;
    const latest = await db.ComplianceAssessment.findOne({ where, order: [['created_at', 'DESC']] });
    if (latest) {
        const view = toView(latest.report, { record: latest });
        await cache.set(ck, view, LATEST_TTL);
        return view;
    }
    const { view } = await assessShipment(s.id, { trigger: 'api', reason: 'first-read seed', tenantId: s.tenant_id, now });
    return view;
}

/** Paginated assessment history (newest first) for a shipment. */
async function listHistory(shipmentId, { page = 1, limit = 20, tenantId = null } = {}) {
    const p = Math.max(1, Number.parseInt(page, 10) || 1);
    const l = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));
    const where = { shipment_id: shipmentId };
    if (tenantId) where.tenant_id = tenantId;
    const { count, rows } = await db.ComplianceAssessment.findAndCountAll({
        where, order: [['created_at', 'DESC']], limit: l, offset: (p - 1) * l,
    });
    return { items: rows, total: count, page: p, limit: l, pages: Math.ceil(count / l) || 0 };
}

// ── Event-triggered assessment hook (fire-and-forget) ────────────────────────

/**
 * Best-effort assessment for a shipment. NEVER throws — called from the
 * post-commit path of the workflow/dispatch engines, so a failure must not roll
 * back or break the transition.
 */
async function triggerAssess(shipmentId, { trigger = 'workflow_transition', reason = null, actor = 'system', tenantId = null } = {}) {
    if (!shipmentId) return null;
    try {
        return await assessShipment(shipmentId, { trigger, reason, actor, tenantId });
    } catch (err) {
        logger.warn('compliance agent assessment failed', {
            shipment_id: shipmentId, trigger, code: err && err.code, message: err && err.message,
        });
        return null;
    }
}

module.exports = {
    ENGINE_VERSION,
    assess,
    assessShipment,
    getLatest,
    listHistory,
    triggerAssess,
    toView,
    compose,
    loadContext,
    LATEST_NS,
    LATEST_TTL,
};
