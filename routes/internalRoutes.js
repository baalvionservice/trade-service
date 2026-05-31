'use strict';
// Internal service-to-service ingress (HMAC-authenticated, not user JWT). Mounted at /v1/internal.
const router = require('express').Router();
const internal = require('../controller/internalController');

// Java (financial-services-java) → trade-service finance event bridge.
router.post('/finance-events', internal.financeEvents);

module.exports = router;
