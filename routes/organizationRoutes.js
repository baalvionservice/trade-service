'use strict';
const router = require('express').Router();
const { authMiddleware, requireRole } = require('../middleware/authMiddleware');
const {
    listOrgs, getOrg, createOrg, updateOrg, deleteOrg, updateKyc,
} = require('../controller/organizationController');

// The org directory is tenant data (names, KYC verdicts, risk scores) — it was previously
// readable by anyone with no token, enumerating every org. Reads now require authentication.
router.get('/',           authMiddleware, listOrgs);
router.get('/:id',        authMiddleware, getOrg);
// Onboarding a trade org is an administrative action.
router.post('/',          authMiddleware, requireRole('admin', 'owner', 'super_admin'), createOrg);
// Profile edits require an org admin; the controller additionally scopes the edit to the
// caller's own org and strips identity/compliance fields from the body.
router.put('/:id',        authMiddleware, requireRole('admin', 'owner', 'super_admin'), updateOrg);
router.patch('/:id',      authMiddleware, requireRole('admin', 'owner', 'super_admin'), updateOrg);
// KYC verdict + risk score are platform-compliance fields — an org must never self-approve its
// own KYC (AML). Restricted to platform super_admin.
router.patch('/:id/kyc',  authMiddleware, requireRole('super_admin'), updateKyc);
// Deleting a tenant org is a destructive platform-level action.
router.delete('/:id',     authMiddleware, requireRole('super_admin'), deleteOrg);

module.exports = router;
