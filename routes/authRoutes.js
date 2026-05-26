'use strict';
const router = require('express').Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const ctrl = require('../controller/authController');

router.post('/register', ctrl.register);
router.post('/login', ctrl.login);
router.get('/me', authMiddleware, ctrl.me);

module.exports = router;
