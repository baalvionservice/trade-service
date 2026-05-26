'use strict';
const { Op } = require('sequelize');
const db = require('../models');
const { sendSuccess, sendPaginated } = require('../utils/response');
const { AppError } = require('../utils/errors');

const listDocuments = async (req, res, next) => {
    try {
        const { entity_type, entity_id, doc_type, page = 1, limit = 20 } = req.query;
        const where = {};
        if (entity_type) where.entity_type = entity_type;
        if (entity_id) where.entity_id = entity_id;
        if (doc_type) where.doc_type = doc_type;
        const offset = (Number(page) - 1) * Number(limit);
        const { count, rows } = await db.Document.findAndCountAll({
            where, limit: Number(limit), offset, order: [['created_at', 'DESC']],
        });
        return sendPaginated(req, res, { items: rows, total: count, page: Number(page), limit: Number(limit) });
    } catch (err) {
        return next(err);
    }
};

const getDocument = async (req, res, next) => {
    try {
        const doc = await db.Document.findByPk(req.params.id);
        if (!doc) return next(new AppError('NOT_FOUND', 'Document not found', 404));
        return sendSuccess(req, res, doc);
    } catch (err) {
        return next(err);
    }
};

const createDocument = async (req, res, next) => {
    try {
        const doc = await db.Document.create(req.body);
        return sendSuccess(req, res, doc, 201);
    } catch (err) {
        return next(err);
    }
};

const verifyDocument = async (req, res, next) => {
    try {
        const doc = await db.Document.findByPk(req.params.id);
        if (!doc) return next(new AppError('NOT_FOUND', 'Document not found', 404));
        await doc.update({ status: 'verified' });
        return sendSuccess(req, res, doc);
    } catch (err) {
        return next(err);
    }
};

const rejectDocument = async (req, res, next) => {
    try {
        const doc = await db.Document.findByPk(req.params.id);
        if (!doc) return next(new AppError('NOT_FOUND', 'Document not found', 404));
        await doc.update({ status: 'rejected' });
        return sendSuccess(req, res, doc);
    } catch (err) {
        return next(err);
    }
};

module.exports = { listDocuments, getDocument, createDocument, verifyDocument, rejectDocument };
