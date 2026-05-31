'use strict';
// Customs Filing — typed customs entries + HS classify + tariff + 5-country declaration templates.
// Relies on tenantContext (gateway is the auth boundary), like the other logistics modules.
const router = require('express').Router();
const c = require('../controller/customsController');

// utilities (must precede /:id so 'classify'/'tariff' aren't captured as an :id)
router.post('/classify', c.classify);
router.get('/tariff', c.tariff);

router.get('/', c.list);
router.post('/', c.create);
router.get('/:id/declaration', c.declaration);
router.get('/:id', c.get);
router.patch('/:id', c.patch);
router.post('/:id/submit', c.submit);
router.post('/:id/clear', c.clear);
router.post('/:id/hold', c.hold);

module.exports = router;
