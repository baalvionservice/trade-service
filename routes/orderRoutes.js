'use strict';
// RETIRED: the order lifecycle moved to order-execution-service (:3052).
// The API gateway now routes /api/trade/v1/orders* to that service, so these
// legacy HTTP endpoints are no longer reached through the gateway.
//
// This router is kept (rather than deleted) so the mount in routes/v1.js
// (`router.use('/orders', require('./orderRoutes'))`) and the module export
// shape stay unchanged, and so any direct/internal caller that still hits this
// path gets an explicit, reversible 410 Gone signal instead of a 404 or silent
// wrong behavior. To restore, revert this file to its prior handler wiring.
//
// NOTE: the Order Sequelize model is intentionally left in place — other code
// may still read it internally; only the HTTP surface is retired here.
const router = require('express').Router();

const gone = (_req, res) => res.status(410).json({
    success: false,
    error: {
        code: 'GONE',
        message: 'Order lifecycle has moved to order-execution-service (gateway routes /api/trade/v1/orders).',
    },
});

// Catch every method and every path under the /orders mount. NOTE: Express 5 / path-to-regexp 8
// reject a bare '*' path (`router.all('*', ...)` throws "Missing parameter name"); a path-less
// middleware matches all methods + paths and is the correct Express 5 catch-all.
router.use(gone);

module.exports = router;
