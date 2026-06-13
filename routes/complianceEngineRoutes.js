'use strict';
// Compliance & Sanctions Engine routes (War Room 4, Prompt 8).
// Mounted at /v1/compliance_screening (distinct from the legacy /v1/compliance
// ComplianceCase CRUD). Every route except the public /definition descriptor
// requires a gateway identity; tenant scoping is enforced in the controller
// (ownership) + RLS at the DB.
const router = require('express').Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const ctrl = require('../controller/complianceEngineController');

// Static / non-:id routes FIRST so they are not shadowed by parameterised paths.
router.get('/definition', ctrl.getDefinition); // public screening-model descriptor

router.post('/screen', authMiddleware, ctrl.screenAdhoc); // ad-hoc stateless screen

// Tenant blacklist / whitelist management.
router.get('/lists',        authMiddleware, ctrl.listEntries);
router.post('/lists',       authMiddleware, ctrl.createEntry);
router.patch('/lists/:id',  authMiddleware, ctrl.updateEntry);
router.delete('/lists/:id', authMiddleware, ctrl.deleteEntry);

// Operation-scoped (persisted) screening + history.
router.get('/operations/:operationId',          authMiddleware, ctrl.getOperationLatest);
router.get('/operations/:operationId/history',  authMiddleware, ctrl.getOperationHistory);
router.post('/operations/:operationId/screen',  authMiddleware, ctrl.screenOperation);

// List persisted screenings across the tenant.
router.get('/', authMiddleware, ctrl.listScreenings);

module.exports = router;
