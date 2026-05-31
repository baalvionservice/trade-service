'use strict';
// Insurance claims — file → under_review → approved → paid (or rejected). Relies on tenantContext.
const router = require('express').Router();
const c = require('../controller/insuranceController');

router.get('/', c.listClaims);
router.post('/', c.fileClaim);
router.get('/:id', c.getClaim);
router.post('/:id/assess', c.assessClaim);
router.post('/:id/approve', c.approveClaim);
router.post('/:id/reject', c.rejectClaim);
router.post('/:id/pay', c.payClaim);

module.exports = router;
