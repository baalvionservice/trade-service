'use strict';
const router = require('express').Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const {
    listNotifications, markRead, markAllRead,
} = require('../controller/notificationController');

router.get('/',                 authMiddleware, listNotifications);
router.patch('/:id/read',       authMiddleware, markRead);
router.post('/mark-all-read',   authMiddleware, markAllRead);

module.exports = router;
