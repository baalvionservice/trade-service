'use strict';
const router = require('express').Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const {
    listOrders, getOrder, createOrder, updateOrder, updateOrderStatus, updateOrderFulfillment,
} = require('../controller/orderController');

router.get('/',                    listOrders);
router.get('/:id',                 getOrder);
router.post('/',                   authMiddleware, createOrder);
router.put('/:id',                 authMiddleware, updateOrder);
router.patch('/:id',               authMiddleware, updateOrder);
router.patch('/:id/status',        authMiddleware, updateOrderStatus);
router.patch('/:id/fulfillment',   authMiddleware, updateOrderFulfillment);

module.exports = router;
