'use strict';
// Shipment Workflow State Machine routes (War Room 4, Prompt 2).
// Mounted at /v1/shipment_workflows. Every route requires a gateway identity;
// tenant scoping is enforced in the controller (ownership) + RLS at the DB.
const router = require('express').Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const ctrl = require('../controller/workflowController');

// Static / non-:id routes FIRST so they are not shadowed by '/:id'.
router.get('/definition', ctrl.getDefinition); // public state-machine descriptor

router.post('/webhooks',       authMiddleware, ctrl.createWebhook);
router.get('/webhooks',        authMiddleware, ctrl.listWebhooks);
router.delete('/webhooks/:id', authMiddleware, ctrl.deleteWebhook);

router.get('/',  authMiddleware, ctrl.listWorkflows);
router.post('/', authMiddleware, ctrl.createWorkflow);

router.get('/:id',                  authMiddleware, ctrl.getWorkflow);
router.get('/:id/transitions',      authMiddleware, ctrl.listTransitions);
router.post('/:id/transitions',     authMiddleware, ctrl.dispatchEvent); // core: dispatch an event
router.post('/:id/advance',         authMiddleware, ctrl.advanceWorkflow);
router.get('/:id/deliveries',       authMiddleware, ctrl.listDeliveries);

module.exports = router;
