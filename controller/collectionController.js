'use strict';
const db = require('../models');
const { sendSuccess } = require('../utils/response');
const { AppError } = require('../utils/errors');

// Reserved query keys that control paging/sorting rather than filtering.
const CONTROL_KEYS = new Set(['page', 'limit', 'sortBy', 'order', 'sort', 'offset']);
// Free-text search keys: substring (contains) match across the document.
const SEARCH_KEYS = ['search', 'q', 'query'];

// Flatten a stored row into the document shape the frontend expects:
// the JSONB payload at top level + id/timestamps injected.
const flatten = (row) => ({
    ...(row.data || {}),
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
});

const listDocs = async (req, res, next) => {
    try {
        const collection = req.params.collection;
        const rows = await db.Collection.findAll({
            where: { collection },
            order: [['createdAt', 'DESC']],
            limit: Number(req.query.limit) || 500,
        });
        let docs = rows.map(flatten);

        // Equality filters for any non-control, non-search query param.
        for (const [k, v] of Object.entries(req.query)) {
            if (CONTROL_KEYS.has(k) || SEARCH_KEYS.includes(k) || v === undefined || v === '') continue;
            docs = docs.filter((d) => String(d[k]) === String(v));
        }

        // Free-text search: case-insensitive substring across top-level scalar values.
        const term = (SEARCH_KEYS.map((k) => req.query[k]).find(Boolean) || '').toString().trim().toLowerCase();
        if (term) {
            docs = docs.filter((d) =>
                Object.values(d).some(
                    (val) => (typeof val === 'string' || typeof val === 'number')
                        && String(val).toLowerCase().includes(term),
                ),
            );
        }

        // Arrays go directly under `data` (the long-tail services read res.data || []).
        return sendSuccess(req, res, docs);
    } catch (err) {
        return next(err);
    }
};

const getDoc = async (req, res, next) => {
    try {
        const row = await db.Collection.findByPk(req.params.id);
        if (!row || row.collection !== req.params.collection) {
            return next(new AppError('NOT_FOUND', 'Document not found', 404));
        }
        return sendSuccess(req, res, flatten(row));
    } catch (err) {
        return next(err);
    }
};

const createDoc = async (req, res, next) => {
    try {
        const { id, createdAt, updatedAt, ...data } = req.body || {};
        const row = await db.Collection.create({ collection: req.params.collection, data });
        return sendSuccess(req, res, flatten(row), 201);
    } catch (err) {
        return next(err);
    }
};

const updateDoc = async (req, res, next) => {
    try {
        const row = await db.Collection.findByPk(req.params.id);
        if (!row || row.collection !== req.params.collection) {
            return next(new AppError('NOT_FOUND', 'Document not found', 404));
        }
        const { id, createdAt, updatedAt, ...patch } = req.body || {};
        await row.update({ data: { ...(row.data || {}), ...patch } });
        return sendSuccess(req, res, flatten(row));
    } catch (err) {
        return next(err);
    }
};

const deleteDoc = async (req, res, next) => {
    try {
        const row = await db.Collection.findByPk(req.params.id);
        if (!row || row.collection !== req.params.collection) {
            return next(new AppError('NOT_FOUND', 'Document not found', 404));
        }
        await row.destroy();
        return sendSuccess(req, res, { deleted: true });
    } catch (err) {
        return next(err);
    }
};

module.exports = { listDocs, getDoc, createDoc, updateDoc, deleteDoc };
