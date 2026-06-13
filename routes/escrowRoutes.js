'use strict';
// RETIRED: escrow is now owned by the Java escrow-service (:13017, /api/v1/escrow).
// trade-service must not hold a divergent escrow money state (data-split risk), so this
// HTTP surface returns an explicit, reversible 410 Gone instead of writing to db.Escrow.
// Mirrors the orderRoutes.js retirement precedent. The mount in routes/v1.js
// (`router.use('/escrows', require('./escrowRoutes'))`) and the export shape stay
// unchanged. The Escrow Sequelize model is intentionally KEPT (adminController stats +
// internalController finance-events projection still read it). To restore, revert this file.
const router = require('express').Router();

const gone = (_req, res) => res.status(410).json({
    success: false,
    error: {
        code: 'GONE',
        message: 'Escrow is owned by the Java escrow-service; route money flows there, not trade-service.',
    },
});

// Express 5 / path-to-regexp 8 reject a bare '*' path; a path-less middleware matches all
// methods + paths and is the correct Express 5 catch-all.
router.use(gone);

module.exports = router;
