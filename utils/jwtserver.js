'use strict';
const jwt = require('jsonwebtoken');
const config = require('../config/appConfig');

const verifyAccessToken = (token) => jwt.verify(token, config.jwt.accessSecret);

const signAccessToken = (payload, expiresIn = '24h') =>
    jwt.sign(payload, config.jwt.accessSecret, { expiresIn });

module.exports = { verifyAccessToken, signAccessToken };
