'use strict';
// Shipment Readiness Score Engine routes (War Room 4, Prompt 6).
// Mounted at /v1/shipment_readiness. Every route requires a gateway identity;
// tenant scoping is enforced in the controller (ownership) + RLS at the DB.
const router = require('express').Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const ctrl = require('../controller/readinessController');

// Static / non-:id routes FIRST so they are not shadowed by '/:shipmentId'.
router.get('/definition', ctrl.getDefinition); // public scoring-model descriptor

router.get('/', authMiddleware, ctrl.listScores);

router.get('/:shipmentId',                authMiddleware, ctrl.getReadiness);
router.get('/:shipmentId/history',        authMiddleware, ctrl.getHistory);
router.post('/:shipmentId/recalculate',   authMiddleware, ctrl.recalculate);

module.exports = router;
