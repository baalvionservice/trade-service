'use strict';
// AI Document Validation Engine — routes (Prompt 5).
const router = require('express').Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const {
    validatePayload, validateDocument, listValidations, getValidation,
} = require('../controller/validationController');

// Stateless validation of an explicit payload (no persistence).
router.post('/validate', authMiddleware, validatePayload);

// Document-bound validation (load + validate + persist).
router.post('/',         authMiddleware, validateDocument);

// Persisted validation reports.
router.get('/',          authMiddleware, listValidations);
router.get('/:id',       authMiddleware, getValidation);

module.exports = router;
