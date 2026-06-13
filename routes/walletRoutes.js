'use strict';
const router = require('express').Router();
const { authMiddleware, requireRole } = require('../middleware/authMiddleware');
const { MONEY_ROLES } = require('../utils/financialControls');
const { getWallet, creditWallet, debitWallet } = require('../controller/walletController');

// War Room 3: crediting/debiting a wallet moves money — require a money role.
// Reading the balance stays open to any authenticated org member (the controller
// still enforces org ownership).
const moneyMover = requireRole(...MONEY_ROLES);

router.get('/:orgId',         authMiddleware, getWallet);
router.post('/:orgId/credit', authMiddleware, moneyMover, creditWallet);
router.post('/:orgId/debit',  authMiddleware, moneyMover, debitWallet);

module.exports = router;
