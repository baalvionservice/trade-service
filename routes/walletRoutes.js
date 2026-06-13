'use strict';
// RETIRED: wallet balances are owned by the Java wallet-service (gateway maps
// /api/wallets -> :3039/api/v1/wallets). trade-service must not credit/debit a divergent
// local wallet (data-split risk), so this HTTP surface returns a reversible 410 Gone
// instead of writing to db.Wallet. Mirrors the orderRoutes.js precedent. The mount in
// routes/v1.js and export shape stay unchanged; the Wallet model is intentionally KEPT.
// To restore, revert this file.
const router = require('express').Router();

const gone = (_req, res) => res.status(410).json({
    success: false,
    error: {
        code: 'GONE',
        message: 'Wallets are owned by the Java wallet-service; route money flows there, not trade-service.',
    },
});

// Express 5 / path-to-regexp 8 reject a bare '*' path; a path-less middleware matches all
// methods + paths and is the correct Express 5 catch-all.
router.use(gone);

module.exports = router;
