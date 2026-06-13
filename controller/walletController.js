'use strict';
const db = require('../models');
const { sendSuccess } = require('../utils/response');
const { AppError } = require('../utils/errors');
const { recordAudit } = require('../utils/audit');
const { hasPlatformBypass, actorId, requiresDualApproval } = require('../utils/financialControls');

// Wallets are scoped by org_id. The caller must own the org (auth.orgId matches the
// param) OR be a PLATFORM operator. War Room 3: an org admin/owner no longer
// bypasses org ownership here — only platform operators do. The role required to
// MOVE money (admin/owner/super_admin) is enforced at the route.
function assertOrgAccess(req, paramOrgId, next) {
    if (hasPlatformBypass(req)) return true;
    const callerOrgId = req.auth && (req.auth.orgId || req.auth.tenantId);
    if (!callerOrgId) {
        next(new AppError('FORBIDDEN', 'Organization identity required', 403));
        return false;
    }
    if (String(callerOrgId) !== String(paramOrgId)) {
        next(new AppError('FORBIDDEN', 'Access to this wallet is not allowed', 403));
        return false;
    }
    return true;
}

const getWallet = async (req, res, next) => {
    try {
        if (!assertOrgAccess(req, req.params.orgId, next)) return undefined;
        const wallet = await db.Wallet.findOne({ where: { org_id: req.params.orgId } });
        if (!wallet) return next(new AppError('NOT_FOUND', 'Wallet not found', 404));
        return sendSuccess(req, res, wallet);
    } catch (err) {
        return next(err);
    }
};

const creditWallet = async (req, res, next) => {
    const t = await db.sequelize.transaction();
    try {
        if (!assertOrgAccess(req, req.params.orgId, next)) { await t.rollback(); return undefined; }
        const { amount } = req.body;
        if (!amount || Number(amount) <= 0) {
            await t.rollback();
            return next(new AppError('BAD_REQUEST', 'amount must be positive', 400));
        }
        let wallet = await db.Wallet.findOne({ where: { org_id: req.params.orgId }, transaction: t, lock: true });
        if (!wallet) {
            wallet = await db.Wallet.create({ org_id: req.params.orgId, balance: 0, reserved_balance: 0 }, { transaction: t });
        }
        const before = Number(wallet.balance);
        const newBalance = before + Number(amount);
        await wallet.update({ balance: newBalance }, { transaction: t });
        await t.commit();
        await recordAudit({
            actorId: actorId(req), action: 'wallet.credit', resourceType: 'wallet', resourceId: wallet.org_id,
            tenantId: wallet.tenant_id,
            metadata: { amount: Number(amount), currency: wallet.currency, before, after: newBalance },
        });
        return sendSuccess(req, res, wallet);
    } catch (err) {
        await t.rollback();
        return next(err);
    }
};

const debitWallet = async (req, res, next) => {
    const t = await db.sequelize.transaction();
    try {
        if (!assertOrgAccess(req, req.params.orgId, next)) { await t.rollback(); return undefined; }
        const { amount } = req.body;
        if (!amount || Number(amount) <= 0) {
            await t.rollback();
            return next(new AppError('BAD_REQUEST', 'amount must be positive', 400));
        }
        const wallet = await db.Wallet.findOne({ where: { org_id: req.params.orgId }, transaction: t, lock: true });
        if (!wallet) {
            await t.rollback();
            return next(new AppError('NOT_FOUND', 'Wallet not found', 404));
        }
        // War Room 3: a large debit requires an explicit second-approver assertion
        // (header x-approver-id distinct from the actor). Below the threshold a
        // single authorized money-role user may debit directly.
        if (requiresDualApproval(amount, wallet.currency)) {
            const approver = (req.headers['x-approver-id'] || '').trim();
            if (!approver || approver === String(actorId(req))) {
                await t.rollback();
                await recordAudit({
                    actorId: actorId(req), action: 'wallet.debit.blocked_dual_control', resourceType: 'wallet', resourceId: wallet.org_id,
                    tenantId: wallet.tenant_id,
                    metadata: { amount: Number(amount), currency: wallet.currency, reason: approver ? 'self_approval' : 'no_second_approver' },
                });
                return next(new AppError('APPROVAL_REQUIRED', 'Debit exceeds the dual-control threshold and requires a distinct second approver (x-approver-id)', 403));
            }
        }
        const available = Number(wallet.balance) - Number(wallet.reserved_balance);
        if (available < Number(amount)) {
            await t.rollback();
            return next(new AppError('INSUFFICIENT_FUNDS', 'Insufficient available balance', 400));
        }
        const before = Number(wallet.balance);
        const newBalance = before - Number(amount);
        await wallet.update({ balance: newBalance }, { transaction: t });
        await t.commit();
        await recordAudit({
            actorId: actorId(req), action: 'wallet.debit', resourceType: 'wallet', resourceId: wallet.org_id,
            tenantId: wallet.tenant_id,
            metadata: {
                amount: Number(amount), currency: wallet.currency, before, after: newBalance,
                approver: (req.headers['x-approver-id'] || '').trim() || undefined,
            },
        });
        return sendSuccess(req, res, wallet);
    } catch (err) {
        await t.rollback();
        return next(err);
    }
};

module.exports = { getWallet, creditWallet, debitWallet };
