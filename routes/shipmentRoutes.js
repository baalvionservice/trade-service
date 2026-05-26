'use strict';
const router = require('express').Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const {
    listShipments, getShipment, createShipment, updateShipment,
    addMilestone, addException, updateShipmentStatus,
} = require('../controller/shipmentController');

router.get('/',                    listShipments);
router.get('/:id',                 getShipment);
router.post('/',                   authMiddleware, createShipment);
router.put('/:id',                 authMiddleware, updateShipment);
router.patch('/:id',               authMiddleware, updateShipment);
router.post('/:id/milestones',     authMiddleware, addMilestone);
router.post('/:id/exceptions',     authMiddleware, addException);
router.patch('/:id/status',        authMiddleware, updateShipmentStatus);

module.exports = router;
