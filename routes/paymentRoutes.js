'use strict';
const router = require('express').Router();
const { authMiddleware, requireRole } = require('../middleware/authMiddleware');
const { MONEY_ROLES } = require('../utils/financialControls');
const {
    listPayments, getPayment, createPayment, updatePaymentStatus,
} = require('../controller/paymentController');

// War Room 3: payment creation initiates real fund movement (financeClient) and
// status updates settle payments — both require a money role. Reads stay open
// (tenant-scoped in the controller).
const moneyMover = requireRole(...MONEY_ROLES);

router.get('/',            authMiddleware, listPayments);
router.get('/:id',         authMiddleware, getPayment);
router.post('/',           authMiddleware, moneyMover, createPayment);
router.patch('/:id/status', authMiddleware, moneyMover, updatePaymentStatus);

module.exports = router;
