'use strict';
// Certificate of Origin — typed CoO with issue → chamber-certify lifecycle + e-stamp. Relies on
// tenantContext (gateway is the auth boundary), consistent with the other logistics modules.
const router = require('express').Router();
const coo = require('../controller/certificateOfOriginController');

router.get('/',              coo.list);
router.get('/:id/document',  coo.document);
router.get('/:id',           coo.get);
router.post('/',             coo.create);
router.post('/:id/issue',    coo.issue);
router.post('/:id/submit',   coo.submit);
router.post('/:id/certify',  coo.certify);
router.post('/:id/reject',   coo.reject);

module.exports = router;
