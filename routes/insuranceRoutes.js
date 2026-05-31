'use strict';
// Insurance policies — quote → bind (premium) → active, cancel. Relies on tenantContext.
const router = require('express').Router();
const c = require('../controller/insuranceController');

router.post('/quote', c.quote);
router.get('/', c.listPolicies);
router.post('/', c.createPolicy);
router.get('/:id', c.getPolicy);
router.post('/:id/bind', c.bindPolicy);
router.post('/:id/cancel', c.cancelPolicy);

module.exports = router;
