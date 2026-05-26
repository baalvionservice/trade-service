'use strict';
const router = require('express').Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const {
    listDocuments, getDocument, createDocument, verifyDocument, rejectDocument,
} = require('../controller/documentController');

router.get('/',              listDocuments);
router.get('/:id',           getDocument);
router.post('/',             authMiddleware, createDocument);
router.patch('/:id/verify',  authMiddleware, verifyDocument);
router.patch('/:id/reject',  authMiddleware, rejectDocument);

module.exports = router;
