'use strict';
// Compliance AI Agent routes (War Room 4, Prompt 13).
// Mounted at /v1/compliance_agent (distinct from /v1/compliance_screening, the
// Prompt 8 rule engine this agent builds on). Every route except the public
// /definition descriptor requires a gateway identity; tenant scoping is enforced
// in the controller (ownership) + RLS at the DB.
const router = require('express').Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const ctrl = require('../controller/complianceAgentController');

// Static / non-:id routes FIRST so they are not shadowed by parameterised paths.
router.get('/definition', ctrl.getDefinition); // public agent-model descriptor

router.post('/assess', authMiddleware, ctrl.assessAdhoc); // ad-hoc stateless assessment

// Shipment-scoped (persisted) assessment + history.
router.get('/shipments/:shipmentId',          authMiddleware, ctrl.getShipmentLatest);
router.get('/shipments/:shipmentId/history',  authMiddleware, ctrl.getShipmentHistory);
router.post('/shipments/:shipmentId/assess',  authMiddleware, ctrl.assessShipment);

// List persisted assessments across the tenant.
router.get('/', authMiddleware, ctrl.listAssessments);

module.exports = router;
