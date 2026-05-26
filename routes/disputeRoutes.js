'use strict';
const router = require('express').Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const {
    listDisputes, getDispute, createDispute, updateDispute, addEvidence, resolveDispute,
} = require('../controller/disputeController');

router.get('/',                 listDisputes);
router.get('/:id',              getDispute);
router.post('/',                authMiddleware, createDispute);
router.put('/:id',              authMiddleware, updateDispute);
router.patch('/:id',            authMiddleware, updateDispute);
router.post('/:id/evidence',    authMiddleware, addEvidence);
router.patch('/:id/resolve',    authMiddleware, resolveDispute);

module.exports = router;
