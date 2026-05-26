'use strict';
const db = require('../models');
const { sendSuccess } = require('../utils/response');
const { AppError } = require('../utils/errors');

const getWallet = async (req, res, next) => {
    try {
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
        const { amount } = req.body;
        if (!amount || Number(amount) <= 0) {
            await t.rollback();
            return next(new AppError('BAD_REQUEST', 'amount must be positive', 400));
        }
        let wallet = await db.Wallet.findOne({ where: { org_id: req.params.orgId }, transaction: t, lock: true });
        if (!wallet) {
            wallet = await db.Wallet.create({ org_id: req.params.orgId, balance: 0, reserved_balance: 0 }, { transaction: t });
        }
        const newBalance = Number(wallet.balance) + Number(amount);
        await wallet.update({ balance: newBalance }, { transaction: t });
        await t.commit();
        return sendSuccess(req, res, wallet);
    } catch (err) {
        await t.rollback();
        return next(err);
    }
};

const debitWallet = async (req, res, next) => {
    const t = await db.sequelize.transaction();
    try {
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
        const available = Number(wallet.balance) - Number(wallet.reserved_balance);
        if (available < Number(amount)) {
            await t.rollback();
            return next(new AppError('INSUFFICIENT_FUNDS', 'Insufficient available balance', 400));
        }
        const newBalance = Number(wallet.balance) - Number(amount);
        await wallet.update({ balance: newBalance }, { transaction: t });
        await t.commit();
        return sendSuccess(req, res, wallet);
    } catch (err) {
        await t.rollback();
        return next(err);
    }
};

module.exports = { getWallet, creditWallet, debitWallet };
