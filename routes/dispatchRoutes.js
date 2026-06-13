'use strict';
// Dispatch Orchestration Engine routes (War Room 4, Prompt 11).
// Mounted at /v1/dispatch_orchestrations. Every route requires an identity;
// tenant scoping is enforced in the controller (ownership) + RLS at the DB.
const router = require('express').Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const ctrl = require('../controller/dispatchController');

// Static / non-:id routes FIRST so they are not shadowed by '/:id'.
router.get('/config', ctrl.getConfig); // public descriptor

router.post('/', authMiddleware, ctrl.createPlan);
router.get('/',  authMiddleware, ctrl.listPlans);

router.get('/:id',           authMiddleware, ctrl.getPlan);
router.get('/:id/events',    authMiddleware, ctrl.getEvents);
router.post('/:id/signals',  authMiddleware, ctrl.signalCondition);
router.post('/:id/dispatch', authMiddleware, ctrl.triggerDispatch);
router.post('/:id/rollback', authMiddleware, ctrl.rollback);
router.post('/:id/retry',    authMiddleware, ctrl.retryDispatch);
router.post('/:id/cancel',   authMiddleware, ctrl.cancelPlan);

module.exports = router;
