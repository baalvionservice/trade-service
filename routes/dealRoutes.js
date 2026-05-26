'use strict';
const router = require('express').Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const {
    listDeals, getDeal, createDeal, updateDeal, finalizeDeal, commitDeal,
} = require('../controller/dealController');

router.get('/',                listDeals);
router.get('/:id',             getDeal);
router.post('/',               authMiddleware, createDeal);
router.put('/:id',             authMiddleware, updateDeal);
router.patch('/:id',           authMiddleware, updateDeal);
router.patch('/:id/finalize',  authMiddleware, finalizeDeal);
router.patch('/:id/commit',    authMiddleware, commitDeal);

module.exports = router;
