'use strict';
const router = require('express').Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const {
    listQuotations, getQuotation, createQuotation, updateQuotation,
} = require('../controller/quotationController');

router.get('/',      authMiddleware, listQuotations);
router.get('/:id',   authMiddleware, getQuotation);
router.post('/',     authMiddleware, createQuotation);
router.patch('/:id', authMiddleware, updateQuotation);

module.exports = router;
