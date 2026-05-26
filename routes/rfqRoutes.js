'use strict';
const router = require('express').Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const {
    listRfqs, getRfq, createRfq, updateRfq, closeRfq, awardRfq,
} = require('../controller/rfqController');

router.get('/',              listRfqs);
router.get('/:id',           getRfq);
router.post('/',             authMiddleware, createRfq);
router.put('/:id',           authMiddleware, updateRfq);
router.patch('/:id',         authMiddleware, updateRfq);
router.patch('/:id/close',   authMiddleware, closeRfq);
router.patch('/:id/award',   authMiddleware, awardRfq);

module.exports = router;
