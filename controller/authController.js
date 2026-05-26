'use strict';
const bcrypt = require('bcrypt');
const { signAccessToken } = require('../utils/jwtserver');
const db = require('../models');
const { sendSuccess } = require('../utils/response');
const { AppError } = require('../utils/errors');

const register = async (req, res, next) => {
    try {
        const { email, password, name, role } = req.body;
        if (!email || !password) return next(new AppError('BAD_REQUEST', 'email and password are required', 400));
        const existing = await db.User.findOne({ where: { email } });
        if (existing) return next(new AppError('CONFLICT', 'Email already registered', 409));
        const password_hash = await bcrypt.hash(password, 10);
        const user = await db.User.create({
            email,
            password_hash,
            full_name: name || '',
            role: ['admin', 'operator', 'client'].includes(role) ? role : 'operator',
        });
        const payload = { id: user.id, email: user.email, role: user.role };
        const accessToken = signAccessToken(payload, '24h');
        return sendSuccess(req, res, { accessToken, role: user.role, userId: user.id }, 201);
    } catch (err) { return next(err); }
};

const login = async (req, res, next) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return next(new AppError('BAD_REQUEST', 'email and password are required', 400));
        const user = await db.User.findOne({ where: { email } });
        if (!user) return next(new AppError('UNAUTHORIZED', 'Invalid credentials', 401));
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) return next(new AppError('UNAUTHORIZED', 'Invalid credentials', 401));
        if (!user.is_active) return next(new AppError('FORBIDDEN', 'Account is deactivated', 403));
        const payload = { id: user.id, email: user.email, role: user.role };
        const accessToken = signAccessToken(payload, '24h');
        return sendSuccess(req, res, { accessToken, role: user.role, userId: user.id });
    } catch (err) { return next(err); }
};

const me = async (req, res, next) => {
    try {
        const user = await db.User.findByPk(req.auth.userId, {
            attributes: { exclude: ['password_hash'] },
        });
        if (!user) return next(new AppError('NOT_FOUND', 'User not found', 404));
        return sendSuccess(req, res, user);
    } catch (err) { return next(err); }
};

module.exports = { register, login, me };
