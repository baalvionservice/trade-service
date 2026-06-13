'use strict';
// Logistics Optimization Agent routes (War Room 4, Prompt 14).
// Mounted at /v1/route_optimizations. The network descriptor is public; running an
// optimization, persisting + selecting require a gateway identity; tenant scoping is
// enforced in the controller (ownership) + RLS.
const router = require('express').Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const ctrl = require('../controller/logisticsController');

// Static / non-:id routes FIRST so they are not shadowed by '/:id'.
router.get('/network', ctrl.getNetwork);                     // public network/carrier descriptor
router.post('/preview', authMiddleware, ctrl.preview);       // stateless optimize (no persistence)

router.post('/', authMiddleware, ctrl.createOptimization);   // optimize + persist
router.get('/',  authMiddleware, ctrl.listOptimizations);

router.get('/:id',         authMiddleware, ctrl.getOptimization);
router.get('/:id/events',  authMiddleware, ctrl.getEvents);
router.post('/:id/select', authMiddleware, ctrl.selectRoute);

module.exports = router;
