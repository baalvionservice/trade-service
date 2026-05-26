'use strict';
const router = require('express').Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const { listMessages, createMessage } = require('../controller/messageController');

router.get('/',   authMiddleware, listMessages);
router.post('/',  authMiddleware, createMessage);

module.exports = router;
