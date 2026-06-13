'use strict';
// Trade Operations Dashboard routes (War Room 4, Prompt 3).
// Mounted at /v1/dashboard. Every route requires a gateway identity; RBAC
// (buyer/seller/admin/logistics/bank) + party scope is enforced in the
// controller, tenant isolation by the model hooks + DB RLS, and per-caller
// rate limiting by the limiters below (on top of the global IP limiter).
//
// Path note: the new Trade Operations Cloud shipments live in schema `tradeops`
// (UUID PK). The legacy /v1/shipments collection (trade.shipments, INTEGER PK)
// is a different entity, so the dashboard is namespaced under /dashboard to
// avoid colliding with it.
const router = require('express').Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const { readLimiter, commentLimiter } = require('../middleware/dashboardRateLimit');
const ctrl = require('../controller/dashboardController');

router.get('/shipments',               authMiddleware, readLimiter, ctrl.listShipments);
router.get('/shipments/:id',           authMiddleware, readLimiter, ctrl.getShipment);
router.get('/shipments/:id/timeline',  authMiddleware, readLimiter, ctrl.getTimeline);
router.get('/shipments/:id/readiness', authMiddleware, readLimiter, ctrl.getReadiness);
router.get('/shipments/:id/documents', authMiddleware, readLimiter, ctrl.getDocuments);
router.post('/shipments/:id/comments', authMiddleware, commentLimiter, ctrl.addComment);

module.exports = router;
