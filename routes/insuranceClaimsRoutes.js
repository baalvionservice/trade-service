'use strict';
// Insurance claims — file → under_review → approved → paid (or rejected).
// These routes previously had NO authMiddleware and only "relied on tenantContext" — but
// tenantContext is NOT authentication. With v1Routes mounted without a global auth gate, an
// unauthenticated caller could approve and PAY claims (payClaim initiates a real payout).
// Reads/file require authentication (controller tenant-scopes); adjudication + payout require
// an org admin (matches insuranceController.isAdmin: admin/owner/super_admin).
const router = require('express').Router();
const { authMiddleware, requireRole } = require('../middleware/authMiddleware');
const c = require('../controller/insuranceController');

const claimsAdmin = requireRole('admin', 'owner', 'super_admin');

router.get('/', authMiddleware, c.listClaims);
router.post('/', authMiddleware, c.fileClaim);
router.get('/:id', authMiddleware, c.getClaim);
router.post('/:id/assess', authMiddleware, claimsAdmin, c.assessClaim);
router.post('/:id/approve', authMiddleware, claimsAdmin, c.approveClaim);
router.post('/:id/reject', authMiddleware, claimsAdmin, c.rejectClaim);
router.post('/:id/pay', authMiddleware, claimsAdmin, c.payClaim);

module.exports = router;
