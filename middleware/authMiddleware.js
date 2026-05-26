'use strict';
const jwtserver = require('../utils/jwtserver');
const { AppError } = require('../utils/errors');

const authMiddleware = (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return next(new AppError('UNAUTHORIZED', 'No bearer token provided', 401));
        const decoded = jwtserver.verifyAccessToken(token);
        req.auth = {
            userId: decoded.id,
            email: decoded.email,
            orgId: decoded.orgId || null,
            role: decoded.role || 'client',
            tenantId: decoded.tenantId || null,
            permissions: decoded.permissions || [],
        };
        req.user = { id: req.auth.userId, role: req.auth.role, orgId: req.auth.orgId };
        return next();
    } catch {
        return next(new AppError('UNAUTHORIZED', 'Invalid or expired token', 401));
    }
};

const requireRole = (...roles) => (req, res, next) => {
    if (!req.auth) return next(new AppError('UNAUTHORIZED', 'Authentication required', 401));
    if (!roles.includes(req.auth.role)) {
        return next(new AppError('FORBIDDEN', `Role '${req.auth.role}' is not authorized for this action`, 403));
    }
    return next();
};

module.exports = { authMiddleware, requireRole };
