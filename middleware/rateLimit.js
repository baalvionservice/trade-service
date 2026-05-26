'use strict';
const config = require('../config/appConfig');

const windows = new Map();

const rateLimit = (max, windowMs = 60_000) => (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    const entry = windows.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + windowMs; }
    entry.count++;
    windows.set(key, entry);
    if (entry.count > max) {
        return res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
    }
    return next();
};

module.exports = () => rateLimit(config.security?.ipRateLimit || 120);
