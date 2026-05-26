'use strict';
const router = require('express').Router();
const { authMiddleware, requireRole } = require('../middleware/authMiddleware');
const { dashboard, analytics, listAdminOrgs } = require('../controller/adminController');

router.use(authMiddleware);
router.use(requireRole('admin', 'operator'));

router.get('/dashboard',    dashboard);
router.get('/analytics',    analytics);
router.get('/organizations', listAdminOrgs);

module.exports = router;
