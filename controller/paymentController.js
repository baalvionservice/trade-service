'use strict';
const db = require('../models');
const config = require('../config/appConfig');
const { sendSuccess, sendPaginated } = require('../utils/response');
const { AppError } = require('../utils/errors');
const { initiatePayment, refFromInitiate } = require('../lib/financeClient');

const listPayments = async (req, res, next) => {
    try {
        const { order_id, status, payer_org_id, payee_org_id, page = 1, limit = 20 } = req.query;
        const where = {};
        if (order_id) where.order_id = order_id;
        if (status) where.status = status;
        if (payer_org_id) where.payer_org_id = payer_org_id;
        if (payee_org_id) where.payee_org_id = payee_org_id;
        const offset = (Number(page) - 1) * Number(limit);
        const { count, rows } = await db.Payment.findAndCountAll({
            where, limit: Number(limit), offset, order: [['created_at', 'DESC']],
        });
        return sendPaginated(req, res, { items: rows, total: count, page: Number(page), limit: Number(limit) });
    } catch (err) {
        return next(err);
    }
};

const getPayment = async (req, res, next) => {
    try {
        const payment = await db.Payment.findByPk(req.params.id);
        if (!payment) return next(new AppError('NOT_FOUND', 'Payment not found', 404));
        return sendSuccess(req, res, payment);
    } catch (err) {
        return next(err);
    }
};

const createPayment = async (req, res, next) => {
    try {
        // Local projection row (fast UI reads; reconciled by the finance-events webhook).
        const payment = await db.Payment.create(req.body);

        // Route the real money movement through financial-services-java (system of record).
        // Disabled (default in this sandbox where the Java suite isn't running) → pure local behavior.
        if (config.finance.enabled) {
            const ctx = {
                tenantId: req.tenantId,
                idempotencyKey: req.headers['x-idempotency-key'] || `pmt-${payment.id}`,
                bearer: (req.headers.authorization || '').split(' ')[1] || undefined,
            };
            try {
                const result = await initiatePayment({
                    amount: payment.amount,
                    currency: payment.currency,
                    scheme: req.body.scheme || req.body.payment_scheme,
                    sourceAccountId: req.body.source_account_id,
                    destinationAccountId: req.body.destination_account_id,
                    metadata: {
                        payerOrgId: payment.payer_org_id, payeeOrgId: payment.payee_org_id,
                        orderId: payment.order_id, method: payment.method,
                    },
                }, ctx);
                const ref = refFromInitiate(result);
                await payment.update({
                    provider_tx_id: ref ? String(ref) : payment.provider_tx_id,
                    status: 'processing',
                    metadata: { ...(payment.metadata || {}), financeInitiated: true, financeStatus: result && result.status },
                });
            } catch (e) {
                // Money must be real when enabled — surface the failure (no 500), keep the pending row for audit/retry.
                await payment.update({ metadata: { ...(payment.metadata || {}), financeError: e.message, financeStatus: 'initiate_failed' } });
                return next(new AppError('FINANCE_UNAVAILABLE', `payment engine error: ${e.message}`, e.status && e.status < 500 ? 400 : 502));
            }
        }
        return sendSuccess(req, res, payment, 201);
    } catch (err) {
        return next(err);
    }
};

const updatePaymentStatus = async (req, res, next) => {
    try {
        const payment = await db.Payment.findByPk(req.params.id);
        if (!payment) return next(new AppError('NOT_FOUND', 'Payment not found', 404));
        const { status, settled_at } = req.body;
        if (!status) return next(new AppError('BAD_REQUEST', 'status is required', 400));
        const updates = { status };
        if (status === 'completed' && !settled_at) updates.settled_at = new Date();
        if (settled_at) updates.settled_at = settled_at;
        await payment.update(updates);
        return sendSuccess(req, res, payment);
    } catch (err) {
        return next(err);
    }
};

module.exports = { listPayments, getPayment, createPayment, updatePaymentStatus };
