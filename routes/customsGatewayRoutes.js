'use strict';
// Customs Gateway Abstraction Layer routes (War Room 4, Prompt 9).
// Mounted at /v1/customs_submissions (distinct from the legacy typed
// /v1/customs_entries). Every route requires a gateway identity; tenant scoping is
// enforced in the controller (ownership) + RLS at the DB.
const router = require('express').Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const ctrl = require('../controller/customsGatewayController');

// Static / non-:id routes FIRST so they are not shadowed by '/:id'.
router.get('/channels', ctrl.getChannels);            // public connector descriptor
router.post('/recover', authMiddleware, ctrl.recoverStalled); // admin recovery sweep

router.post('/', authMiddleware, ctrl.createSubmission);
router.get('/',  authMiddleware, ctrl.listSubmissions);

router.get('/:id',            authMiddleware, ctrl.getSubmission);
router.get('/:id/events',     authMiddleware, ctrl.getEvents);
router.post('/:id/retry',     authMiddleware, ctrl.retrySubmission);
router.post('/:id/cancel',    authMiddleware, ctrl.cancelSubmission);

module.exports = router;
