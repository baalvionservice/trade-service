'use strict';
const router = require('express').Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const {
    listOrgs, getOrg, createOrg, updateOrg, deleteOrg, updateKyc,
} = require('../controller/organizationController');

router.get('/',           listOrgs);
router.get('/:id',        getOrg);
router.post('/',          authMiddleware, createOrg);
router.put('/:id',        authMiddleware, updateOrg);
router.patch('/:id',      authMiddleware, updateOrg);
router.patch('/:id/kyc',  authMiddleware, updateKyc);
router.delete('/:id',     authMiddleware, deleteOrg);

module.exports = router;
