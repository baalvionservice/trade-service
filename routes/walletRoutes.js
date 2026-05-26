'use strict';
const router = require('express').Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const { getWallet, creditWallet, debitWallet } = require('../controller/walletController');

router.get('/:orgId',         authMiddleware, getWallet);
router.post('/:orgId/credit', authMiddleware, creditWallet);
router.post('/:orgId/debit',  authMiddleware, debitWallet);

module.exports = router;
