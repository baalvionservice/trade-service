'use strict';
const router = require('express').Router();
const { authMiddleware, requireRole } = require('../middleware/authMiddleware');
const { MONEY_ROLES } = require('../utils/financialControls');
const {
    listEscrows, getEscrow, createEscrow, fundEscrow, releaseEscrow, refundEscrow,
} = require('../controller/escrowController');

// War Room 3: only money roles (admin/owner/super_admin) may move escrowed funds.
// Reads stay open to any authenticated tenant member (still tenant-scoped in the
// controller). create/fund/release/refund all touch money and are role-gated.
const moneyMover = requireRole(...MONEY_ROLES);

router.get('/',              authMiddleware, listEscrows);
router.get('/:id',           authMiddleware, getEscrow);
router.post('/',             authMiddleware, moneyMover, createEscrow);
router.patch('/:id/fund',    authMiddleware, moneyMover, fundEscrow);
router.patch('/:id/release', authMiddleware, moneyMover, releaseEscrow);
router.patch('/:id/refund',  authMiddleware, moneyMover, refundEscrow);

module.exports = router;
