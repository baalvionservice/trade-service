'use strict';
// Freight Marketplace Integration Layer routes (War Room 4, Prompt 10).
// Mounted at /v1/freight (distinct from the legacy /carriers + /shipping_quotes
// store-shadow endpoints). Carrier discovery is public; quoting + booking require a
// gateway identity; tenant scoping is enforced in the controller (ownership) + RLS.
const router = require('express').Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const ctrl = require('../controller/freightMarketplaceController');

// Static / non-:id routes FIRST so they are not shadowed by '/:id'.
router.get('/carriers', ctrl.getCarriers);                 // public marketplace descriptor
router.post('/quotes', authMiddleware, ctrl.compareQuotes); // quote comparison engine
router.post('/recover', authMiddleware, ctrl.recoverStalled); // admin recovery sweep

router.post('/', authMiddleware, ctrl.createBooking);
router.get('/',  authMiddleware, ctrl.listBookings);

router.get('/:id',          authMiddleware, ctrl.getBooking);
router.get('/:id/events',   authMiddleware, ctrl.getEvents);
router.post('/:id/status',  authMiddleware, ctrl.updateStatus);
router.post('/:id/retry',   authMiddleware, ctrl.retryBooking);
router.post('/:id/cancel',  authMiddleware, ctrl.cancelBooking);

module.exports = router;
