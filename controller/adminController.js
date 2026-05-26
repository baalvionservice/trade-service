'use strict';
const { Op, fn, col, literal } = require('sequelize');
const db = require('../models');
const { sendSuccess } = require('../utils/response');
const { AppError } = require('../utils/errors');

const dashboard = async (req, res, next) => {
    try {
        const [
            orgCount, rfqCount, dealCount, orderCount,
            escrowCount, shipmentCount, paymentCount,
            complianceCount, disputeCount, paymentVolume,
        ] = await Promise.all([
            db.Organization.count(),
            db.Rfq.count(),
            db.Deal.count(),
            db.Order.count(),
            db.Escrow.count(),
            db.Shipment.count(),
            db.Payment.count(),
            db.ComplianceCase.count(),
            db.Dispute.count(),
            db.Payment.findOne({
                attributes: [[fn('SUM', col('amount')), 'total_volume']],
                where: { status: 'completed' },
                raw: true,
            }),
        ]);

        return sendSuccess(req, res, {
            counts: {
                organizations: orgCount,
                rfqs: rfqCount,
                deals: dealCount,
                orders: orderCount,
                escrows: escrowCount,
                shipments: shipmentCount,
                payments: paymentCount,
                compliance_cases: complianceCount,
                disputes: disputeCount,
            },
            total_payment_volume_usd: paymentVolume ? Number(paymentVolume.total_volume || 0) : 0,
        });
    } catch (err) {
        return next(err);
    }
};

const analytics = async (req, res, next) => {
    try {
        const [dealsByStatus, ordersByFulfillment, paymentsByCurrency, shipmentsByStatus] = await Promise.all([
            db.Deal.findAll({
                attributes: ['status', [fn('COUNT', col('id')), 'count']],
                group: ['status'],
                raw: true,
            }),
            db.Order.findAll({
                attributes: ['fulfillment_state', [fn('COUNT', col('id')), 'count']],
                group: ['fulfillment_state'],
                raw: true,
            }),
            db.Payment.findAll({
                attributes: ['currency', [fn('SUM', col('amount')), 'total'], [fn('COUNT', col('id')), 'count']],
                group: ['currency'],
                raw: true,
            }),
            db.Shipment.findAll({
                attributes: ['status', [fn('COUNT', col('id')), 'count']],
                group: ['status'],
                raw: true,
            }),
        ]);

        return sendSuccess(req, res, {
            deals_by_status: dealsByStatus,
            orders_by_fulfillment_state: ordersByFulfillment,
            payments_by_currency: paymentsByCurrency,
            shipments_by_status: shipmentsByStatus,
        });
    } catch (err) {
        return next(err);
    }
};

const listAdminOrgs = async (req, res, next) => {
    try {
        const { page = 1, limit = 50 } = req.query;
        const offset = (Number(page) - 1) * Number(limit);
        const { count, rows } = await db.Organization.findAndCountAll({
            limit: Number(limit), offset, order: [['created_at', 'DESC']],
        });
        return sendSuccess(req, res, { items: rows, total: count, page: Number(page), limit: Number(limit) });
    } catch (err) {
        return next(err);
    }
};

module.exports = { dashboard, analytics, listAdminOrgs };
