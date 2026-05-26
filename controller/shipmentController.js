'use strict';
const { Op } = require('sequelize');
const db = require('../models');
const { sendSuccess, sendPaginated } = require('../utils/response');
const { AppError } = require('../utils/errors');

const listShipments = async (req, res, next) => {
    try {
        const { status, order_id, carrier_id, page = 1, limit = 20 } = req.query;
        const where = {};
        if (status) where.status = status;
        if (order_id) where.order_id = order_id;
        if (carrier_id) where.carrier_id = carrier_id;
        const offset = (Number(page) - 1) * Number(limit);
        const { count, rows } = await db.Shipment.findAndCountAll({
            where, limit: Number(limit), offset, order: [['created_at', 'DESC']],
        });
        return sendPaginated(req, res, { items: rows, total: count, page: Number(page), limit: Number(limit) });
    } catch (err) {
        return next(err);
    }
};

const getShipment = async (req, res, next) => {
    try {
        const shipment = await db.Shipment.findByPk(req.params.id);
        if (!shipment) return next(new AppError('NOT_FOUND', 'Shipment not found', 404));
        return sendSuccess(req, res, shipment);
    } catch (err) {
        return next(err);
    }
};

const createShipment = async (req, res, next) => {
    try {
        const shipment = await db.Shipment.create(req.body);
        return sendSuccess(req, res, shipment, 201);
    } catch (err) {
        return next(err);
    }
};

const updateShipment = async (req, res, next) => {
    try {
        const shipment = await db.Shipment.findByPk(req.params.id);
        if (!shipment) return next(new AppError('NOT_FOUND', 'Shipment not found', 404));
        await shipment.update(req.body);
        return sendSuccess(req, res, shipment);
    } catch (err) {
        return next(err);
    }
};

const addMilestone = async (req, res, next) => {
    try {
        const shipment = await db.Shipment.findByPk(req.params.id);
        if (!shipment) return next(new AppError('NOT_FOUND', 'Shipment not found', 404));
        const milestone = { ...req.body, timestamp: req.body.timestamp || new Date().toISOString() };
        const milestones = [...(shipment.milestones || []), milestone];
        await shipment.update({ milestones });
        return sendSuccess(req, res, shipment, 201);
    } catch (err) {
        return next(err);
    }
};

const addException = async (req, res, next) => {
    try {
        const shipment = await db.Shipment.findByPk(req.params.id);
        if (!shipment) return next(new AppError('NOT_FOUND', 'Shipment not found', 404));
        const exception = { ...req.body, timestamp: req.body.timestamp || new Date().toISOString() };
        const exceptions = [...(shipment.exceptions || []), exception];
        await shipment.update({ exceptions });
        return sendSuccess(req, res, shipment, 201);
    } catch (err) {
        return next(err);
    }
};

const updateShipmentStatus = async (req, res, next) => {
    try {
        const shipment = await db.Shipment.findByPk(req.params.id);
        if (!shipment) return next(new AppError('NOT_FOUND', 'Shipment not found', 404));
        const { status } = req.body;
        if (!status) return next(new AppError('BAD_REQUEST', 'status is required', 400));
        await shipment.update({ status });
        // Realtime push to the shipment + tenant rooms (best-effort).
        require('../realtime').publish(`shipment:${shipment.id}`, 'status', { id: shipment.id, status }).catch(() => {});
        return sendSuccess(req, res, shipment);
    } catch (err) {
        return next(err);
    }
};

module.exports = { listShipments, getShipment, createShipment, updateShipment, addMilestone, addException, updateShipmentStatus };
