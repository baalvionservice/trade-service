'use strict';
// RETIRED: FX rates/conversion are owned by the Java fx-service (gateway maps /api/fx ->
// :3038/api/v1/fx); order-execution-service (:3052) uses its own providers/fx.js for
// server-computed order totals. trade-service must not be a second FX source of truth, so
// this HTTP surface returns a reversible 410 Gone. Mirrors the orderRoutes.js precedent.
// The mount in routes/v1.js (`router.use('/fx', require('./fxRoutes'))`) and the export
// shape stay unchanged. To restore, revert this file.
const router = require('express').Router();

const gone = (_req, res) => res.status(410).json({
    success: false,
    error: {
        code: 'GONE',
        message: 'FX is owned by the Java fx-service / order-execution-service; do not source FX from trade-service.',
    },
});

// Express 5 / path-to-regexp 8 reject a bare '*' path; a path-less middleware matches all
// methods + paths and is the correct Express 5 catch-all.
router.use(gone);

module.exports = router;
