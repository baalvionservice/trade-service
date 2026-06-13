'use strict';
// RETIRED: payments are owned by the Java payment-service (:13015, /api/v1/payments) and
// orchestrated through order-execution-service (:3052) confirm-payment -> payment_requested
// outbox -> ledger double-entry. trade-service must not create a divergent local payment
// state (data-split risk), so this HTTP surface returns a reversible 410 Gone instead of
// writing to db.Payment. Mirrors the orderRoutes.js precedent. The mount in routes/v1.js
// and the export shape stay unchanged. The Payment Sequelize model is intentionally KEPT
// (adminController platform-stats + internalController finance-events projection read it).
// To restore, revert this file.
const router = require('express').Router();

const gone = (_req, res) => res.status(410).json({
    success: false,
    error: {
        code: 'GONE',
        message: 'Payments are owned by the Java payment-service / order-execution-service; route money flows there, not trade-service.',
    },
});

// Express 5 / path-to-regexp 8 reject a bare '*' path; a path-less middleware matches all
// methods + paths and is the correct Express 5 catch-all.
router.use(gone);

module.exports = router;
