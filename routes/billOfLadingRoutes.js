'use strict';
// Digital Bill of Lading — typed e-B/L with a title-transfer/surrender lifecycle. Relies on
// tenantContext (gateway is the auth boundary), consistent with the other logistics modules.
const router = require('express').Router();
const blc = require('../controller/billOfLadingController');

router.get('/',             blc.list);
router.get('/:id',          blc.get);
router.post('/',            blc.create);
router.post('/:id/issue',     blc.issue);
router.post('/:id/transfer',  blc.transfer);
router.post('/:id/surrender', blc.surrender);
router.post('/:id/release',   blc.release);
router.post('/:id/sign',      blc.sign);
router.post('/:id/cancel',    blc.cancel);

module.exports = router;
