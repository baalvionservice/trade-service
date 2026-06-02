'use strict';
/**
 * Trade Insurance (Logistics #7). Two resources (matching the GTI insurance-service, camelCase, no
 * mapper): policies (quote → bind → active, cancel) and claims (file → under_review → approved → paid,
 * or rejected). Premium pricing via providers/insurance.js; premium charge + claim payout compose the
 * finance facade (Java payment-service) when finance is enabled, else simulated refs.
 */
const crypto = require('crypto');
const db = require('../models');
const config = require('../config/appConfig');
const ins = require('../providers/insurance');
const { initiatePayment, refFromInitiate } = require('../lib/financeClient');
const { sendSuccess } = require('../utils/response');
const { AppError } = require('../utils/errors');

const pid = () => `INS-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
const cid = () => `CLM-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
const num = (x) => (x == null ? 0 : Number(x));

// ── Tenant helpers ────────────────────────────────────────────────────────────
function isAdmin(req) {
    const roles = (req.auth && req.auth.roles) || [];
    return roles.some((r) => r === 'admin' || r === 'super_admin' || r === 'owner');
}

function callerTenantId(req) {
    return (req.auth && (req.auth.tenantId || req.auth.orgId)) || null;
}

async function fetchPolicyOwned(id, req, next) {
    const r = await db.InsurancePolicy.findByPk(id);
    if (!r) { next(new AppError('NOT_FOUND', 'Policy not found', 404)); return null; }
    if (isAdmin(req)) return r;
    const tenantId = callerTenantId(req);
    if (tenantId && r.tenant_id && r.tenant_id !== tenantId) {
        next(new AppError('NOT_FOUND', 'Policy not found', 404)); return null;
    }
    return r;
}

async function fetchClaimOwned(id, req, next) {
    const c = await db.InsuranceClaim.findByPk(id);
    if (!c) { next(new AppError('NOT_FOUND', 'Claim not found', 404)); return null; }
    if (isAdmin(req)) return c;
    const tenantId = callerTenantId(req);
    if (tenantId && c.tenant_id && c.tenant_id !== tenantId) {
        next(new AppError('NOT_FOUND', 'Claim not found', 404)); return null;
    }
    return c;
}

// ── policy mapping ───────────────────────────────────────────────────────────
function policyToApi(r) {
    return {
        id: r.id, shipmentId: r.shipment_id, orderId: r.order_id, policyNumber: r.policy_number,
        type: r.insurance_type, status: r.status, provider: r.provider,
        coverageAmount: num(r.coverage_amount), currency: r.currency, premium: num(r.premium),
        premiumRate: r.premium_rate != null ? Number(r.premium_rate) : undefined, deductible: num(r.deductible),
        insured: r.insured, beneficiary: r.beneficiary, coverageTerms: r.coverage_terms,
        parametricTrigger: r.parametric_trigger, premiumPaymentRef: r.premium_payment_ref,
        startDate: r.start_date, endDate: r.end_date, boundAt: r.bound_at,
        createdAt: r.created_at, updatedAt: r.updated_at,
    };
}

function policyFromApi(b = {}) {
    const v = {
        shipment_id: b.shipmentId ?? b.shipment_id,
        order_id: b.orderId ?? b.order_id,
        insurance_type: b.type ?? b.insuranceType ?? b.insurance_type,
        provider: b.provider,
        coverage_amount: b.coverageAmount ?? b.coverage_amount,
        currency: b.currency,
        insured: b.insured,
        beneficiary: b.beneficiary,
        coverage_terms: b.coverageTerms ?? b.coverage_terms,
        parametric_trigger: b.parametricTrigger ?? b.parametric_trigger,
        metadata: b.metadata,
    };
    Object.keys(v).forEach((k) => v[k] === undefined && delete v[k]);
    return v;
}

// ── policies ─────────────────────────────────────────────────────────────────
const quote = async (req, res, next) => {
    try {
        const b = req.body || {};
        const q = ins.computePremium({
            insuranceType: b.type ?? b.insuranceType, coverageAmount: b.coverageAmount,
            riskMultiplier: b.riskMultiplier, deductibleRate: b.deductibleRate,
        });
        return sendSuccess(req, res, { ...q, currency: b.currency || 'USD' });
    } catch (err) { return next(err); }
};

const listPolicies = async (req, res, next) => {
    try {
        const where = {};
        const sid = req.query.shipmentId || req.query.shipment_id;
        if (sid) where.shipment_id = sid;
        if (req.query.status) where.status = req.query.status;
        if (req.query.type) where.insurance_type = req.query.type;
        if (!isAdmin(req)) {
            const tenantId = callerTenantId(req);
            if (tenantId) where.tenant_id = tenantId;
        }
        const rows = await db.InsurancePolicy.findAll({ where, order: [['created_at', 'DESC']], limit: 500 });
        return sendSuccess(req, res, rows.map(policyToApi));
    } catch (err) { return next(err); }
};

const getPolicy = async (req, res, next) => {
    try {
        const r = await fetchPolicyOwned(req.params.id, req, next);
        if (!r) return undefined;
        return sendSuccess(req, res, policyToApi(r));
    } catch (err) { return next(err); }
};

const createPolicy = async (req, res, next) => {
    try {
        const b = req.body || {};
        const v = policyFromApi(b);
        const q = ins.computePremium({ insuranceType: v.insurance_type, coverageAmount: v.coverage_amount, riskMultiplier: b.riskMultiplier, deductibleRate: b.deductibleRate });
        v.id = b.id || pid();
        v.policy_number = b.policyNumber || `POL-${crypto.randomInt(10000000, 99999999)}`;
        v.premium = b.premium != null ? b.premium : q.premium;
        v.premium_rate = q.premiumRate;
        v.deductible = b.deductible != null ? b.deductible : q.deductible;
        v.status = 'pending'; // quoted, awaiting bind
        // Stamp tenant_id from server context; never accept from client.
        const tenantId = callerTenantId(req);
        if (tenantId) v.tenant_id = tenantId;
        const row = await db.InsurancePolicy.create(v);
        return sendSuccess(req, res, policyToApi(row), 201);
    } catch (err) { return next(err); }
};

// POST /:id/bind — pay the premium and activate the cover.
const bindPolicy = async (req, res, next) => {
    try {
        const r = await fetchPolicyOwned(req.params.id, req, next);
        if (!r) return undefined;
        if (r.status === 'active') return sendSuccess(req, res, policyToApi(r));
        if (!['pending', 'quoted'].includes(r.status)) {
            return next(new AppError('INVALID_TRANSITION', `cannot bind a policy in '${r.status}' state`, 409));
        }
        let premiumRef = `PREM-${crypto.randomInt(100000, 999999)}`;
        if (config.finance.enabled) {
            try {
                const result = await initiatePayment({ amount: num(r.premium), currency: r.currency, scheme: 'INTERNAL', metadata: { kind: 'insurance_premium', policyId: r.id } },
                    { tenantId: req.tenantId, idempotencyKey: `prem-${r.id}` });
                premiumRef = refFromInitiate(result) || premiumRef;
            } catch (e) {
                return next(new AppError('FINANCE_UNAVAILABLE', `premium charge failed: ${e.message}`, e.status && e.status < 500 ? 400 : 502));
            }
        }
        const months = Number((req.body && req.body.termMonths) || 6);
        const start = new Date();
        const end = new Date(start.getTime() + months * 30 * 86400000);
        await r.update({ status: 'active', bound_at: new Date(), premium_payment_ref: premiumRef, start_date: start, end_date: end });
        return sendSuccess(req, res, policyToApi(r));
    } catch (err) { return next(err); }
};

const cancelPolicy = async (req, res, next) => {
    try {
        const r = await fetchPolicyOwned(req.params.id, req, next);
        if (!r) return undefined;
        await r.update({ status: 'cancelled', metadata: { ...(r.metadata || {}), cancelReason: (req.body && req.body.reason) || null } });
        return sendSuccess(req, res, policyToApi(r));
    } catch (err) { return next(err); }
};

// ── claims ───────────────────────────────────────────────────────────────────
const CLAIM_VALID = {
    filed: ['under_review', 'rejected'],
    under_review: ['approved', 'rejected'],
    approved: ['paid'],
    paid: [], rejected: [],
};
function claimToApi(r) {
    return {
        id: r.id, policyId: r.policy_id, shipmentId: r.shipment_id, claimNumber: r.claim_number,
        amount: num(r.amount), status: r.status, reason: r.reason, assessor: r.assessor,
        payoutAmount: r.payout_amount != null ? num(r.payout_amount) : undefined, payoutRef: r.payout_ref,
        filedAt: r.filed_at, resolvedAt: r.resolved_at, paidAt: r.paid_at,
        createdAt: r.created_at, updatedAt: r.updated_at,
    };
}
// findClaim enforces tenant ownership for all lifecycle mutations.
const findClaim = async (req, next) => {
    return fetchClaimOwned(req.params.id, req, next);
};
function assertClaim(c, to) {
    if (!(CLAIM_VALID[c.status] || []).includes(to)) {
        throw new AppError('INVALID_TRANSITION', `cannot move claim from '${c.status}' to '${to}'`, 409);
    }
}

const listClaims = async (req, res, next) => {
    try {
        const where = {};
        const pidq = req.query.policyId || req.query.policy_id;
        if (pidq) where.policy_id = pidq;
        if (req.query.status) where.status = req.query.status;
        if (!isAdmin(req)) {
            const tenantId = callerTenantId(req);
            if (tenantId) where.tenant_id = tenantId;
        }
        const rows = await db.InsuranceClaim.findAll({ where, order: [['created_at', 'DESC']], limit: 500 });
        return sendSuccess(req, res, rows.map(claimToApi));
    } catch (err) { return next(err); }
};

const getClaim = async (req, res, next) => {
    try {
        const c = await fetchClaimOwned(req.params.id, req, next);
        if (!c) return undefined;
        return sendSuccess(req, res, claimToApi(c));
    } catch (err) { return next(err); }
};

const fileClaim = async (req, res, next) => {
    try {
        const b = req.body || {};
        const policyId = b.policyId || b.policy_id;
        if (!policyId) return next(new AppError('BAD_REQUEST', 'policyId is required', 400));
        const policy = await db.InsurancePolicy.findByPk(policyId);
        if (!policy) return next(new AppError('NOT_FOUND', 'Policy not found', 404));
        if (policy.status !== 'active') return next(new AppError('POLICY_NOT_ACTIVE', `policy is '${policy.status}', not active`, 409));
        const amount = num(b.amount);
        if (amount > num(policy.coverage_amount)) {
            return next(new AppError('OVER_COVERAGE', 'claim amount exceeds policy coverage', 400));
        }
        const tenantId = callerTenantId(req);
        const row = await db.InsuranceClaim.create({
            id: b.id || cid(),
            policy_id: policyId,
            shipment_id: b.shipmentId ?? b.shipment_id ?? policy.shipment_id,
            claim_number: b.claimNumber || `CLM-${crypto.randomInt(10000000, 99999999)}`,
            amount,
            reason: b.reason,
            status: 'filed',
            filed_at: new Date(),
            ...(tenantId ? { tenant_id: tenantId } : {}),
        });
        return sendSuccess(req, res, claimToApi(row), 201);
    } catch (err) { return next(err); }
};

const claimAction = (to) => async (req, res, next) => {
    try {
        const c = await findClaim(req, next); if (!c) return undefined;
        assertClaim(c, to);
        const updates = { status: to };
        if (to === 'under_review' && req.body && req.body.assessor) updates.assessor = req.body.assessor;
        if (to === 'approved') updates.payout_amount = req.body && req.body.payoutAmount != null ? Number(req.body.payoutAmount) : num(c.amount);
        if (to === 'rejected') { updates.resolved_at = new Date(); updates.metadata = { ...(c.metadata || {}), rejectReason: (req.body && req.body.reason) || null }; }
        await c.update(updates);
        return sendSuccess(req, res, claimToApi(c));
    } catch (err) { return next(err); }
};

// POST /insurance_claims/:id/pay — pay the approved claim (composes the finance facade) + mark policy claimed.
const payClaim = async (req, res, next) => {
    try {
        const c = await findClaim(req, next); if (!c) return undefined;
        assertClaim(c, 'paid');
        const payout = num(c.payout_amount) || num(c.amount);
        let payoutRef = `PAYOUT-${crypto.randomInt(100000, 999999)}`;
        if (config.finance.enabled) {
            try {
                const policy = await db.InsurancePolicy.findByPk(c.policy_id);
                const result = await initiatePayment({ amount: payout, currency: (policy && policy.currency) || 'USD', scheme: 'INTERNAL', metadata: { kind: 'insurance_payout', claimId: c.id, policyId: c.policy_id } },
                    { tenantId: req.tenantId, idempotencyKey: `payout-${c.id}` });
                payoutRef = refFromInitiate(result) || payoutRef;
            } catch (e) {
                return next(new AppError('FINANCE_UNAVAILABLE', `payout failed: ${e.message}`, e.status && e.status < 500 ? 400 : 502));
            }
        }
        await c.update({ status: 'paid', payout_amount: payout, payout_ref: payoutRef, paid_at: new Date(), resolved_at: new Date() });
        // Mark the policy claimed (best-effort).
        try { const p = await db.InsurancePolicy.findByPk(c.policy_id); if (p) await p.update({ status: 'claimed' }); } catch { /* non-fatal */ }
        return sendSuccess(req, res, claimToApi(c));
    } catch (err) { return next(err); }
};

module.exports = {
    quote, listPolicies, getPolicy, createPolicy, bindPolicy, cancelPolicy,
    listClaims, getClaim, fileClaim,
    assessClaim: claimAction('under_review'), approveClaim: claimAction('approved'), rejectClaim: claimAction('rejected'), payClaim,
};
