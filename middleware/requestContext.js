'use strict';
const { v4: uuidv4 } = require('uuid');

module.exports = (req, res, next) => {
    req.requestId = uuidv4();
    req.startTime = Date.now();
    res.set('X-Request-Id', req.requestId);
    next();
};
