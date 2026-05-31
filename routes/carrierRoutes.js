'use strict';
// Logistics carrier marketplace (global registry). Public read; the freight quote engine + selection
// live under /shipping_quotes and /shipping_selections (mounted in v1.js).
const router = require('express').Router();
const { listCarriers, getCarrier } = require('../controller/freightController');

router.get('/',    listCarriers);
router.get('/:id', getCarrier);

module.exports = router;
