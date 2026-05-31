'use strict';
// Carbon Footprint — CO2e estimate per shipment + offset + ESG report. Relies on tenantContext.
const router = require('express').Router();
const c = require('../controller/carbonController');

// utilities (precede /:id)
router.get('/estimate', c.estimate);
router.get('/report', c.report);

router.get('/', c.list);
router.post('/', c.create);
router.get('/:id', c.get);
router.post('/:id/offset', c.offset);

module.exports = router;
