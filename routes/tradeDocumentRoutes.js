'use strict';
// Document Management System routes (War Room 4, Prompt 4) — mounted at
// /v1/trade_documents. Distinct from the legacy /v1/documents (light metadata store).
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const config = require('../config/appConfig');
const ctrl = require('../controller/tradeDocumentController');

// Raw-binary body parser for the upload endpoints. Engages for any non-JSON
// Content-Type (application/pdf, image/*, application/octet-stream, …) so the file
// arrives as a Buffer on req.body. JSON uploads ({ file_base64 }) fall through to
// the app-level express.json parser. Limit matches the engine's max upload size.
const rawUpload = express.raw({
    type: (req) => !req.is('application/json'),
    limit: config.documents.maxUploadBytes,
});

// Capabilities / definition (doc types, limits, encryption + scan posture).
router.get('/meta/capabilities', authMiddleware, ctrl.getCapabilities);

// Document collection.
router.get('/', authMiddleware, ctrl.listDocuments);
router.post('/', authMiddleware, ctrl.createDocument);
router.get('/:id', authMiddleware, ctrl.getDocument);
router.delete('/:id', authMiddleware, ctrl.deleteDocument);

// Versions (the file engine).
router.get('/:id/versions', authMiddleware, ctrl.listVersions);
router.post('/:id/versions', authMiddleware, rawUpload, ctrl.uploadVersion);

// Downloads — latest by default, or ?version=N, or a specific version id.
router.get('/:id/download', authMiddleware, ctrl.downloadVersion);
router.get('/:id/versions/:versionId/download', authMiddleware, ctrl.downloadVersion);

// Scan recovery.
router.post('/:id/versions/:versionId/rescan', authMiddleware, ctrl.rescanVersion);

// Review outcomes + chain of custody.
router.patch('/:id/verify', authMiddleware, ctrl.verifyDocument);
router.patch('/:id/reject', authMiddleware, ctrl.rejectDocument);
router.get('/:id/events', authMiddleware, ctrl.listEvents);

module.exports = router;
