'use strict';
// Insurance policies — quote → bind (premium) → active, cancel.
// Same flaw as insuranceClaimsRoutes: these had no authMiddleware and "relied on tenantContext"
// (which is not authentication). bind charges a premium and cancel reverses a policy, so all
// routes now require authentication; bind/cancel additionally require an org admin.
const router = require('express').Router();
const { authMiddleware, requireRole } = require('../middleware/authMiddleware');
const c = require('../controller/insuranceController');

const policyAdmin = requireRole('admin', 'owner', 'super_admin');

router.post('/quote', authMiddleware, c.quote);
router.get('/', authMiddleware, c.listPolicies);
router.post('/', authMiddleware, c.createPolicy);
router.get('/:id', authMiddleware, c.getPolicy);
router.post('/:id/bind', authMiddleware, policyAdmin, c.bindPolicy);
router.post('/:id/cancel', authMiddleware, policyAdmin, c.cancelPolicy);

module.exports = router;
