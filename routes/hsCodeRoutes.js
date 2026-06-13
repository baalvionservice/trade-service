'use strict';
// HS Code Intelligence Engine — routes (Prompt 7).
// NOTE: literal paths are declared BEFORE the `/:code` lookup so they are not
// swallowed by the param route.
const router = require('express').Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const {
    searchCodes, suggest, classify, listClassifications, getClassification,
    estimateDuty, lookup,
} = require('../controller/hsCodeController');

// Search API — keyword search over the HS database (stateless).
router.get('/search', authMiddleware, searchCodes);

// Stateless product → HS suggestion pipeline (no persistence).
router.post('/suggest', authMiddleware, suggest);

// Operation-bound classification (suggest + persist as an HsClassification).
router.post('/classify', authMiddleware, classify);

// Duty estimation hook.
router.post('/duty', authMiddleware, estimateDuty);

// Persisted classification audit.
router.get('/classifications', authMiddleware, listClassifications);
router.get('/classifications/:id', authMiddleware, getClassification);

// Lookup a specific HS code (national line + compliance flags + duty). LAST.
router.get('/:code', authMiddleware, lookup);

module.exports = router;
