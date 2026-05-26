'use strict';
const queue = require('../queue');
const { workerMetrics } = require('../queue/workers');
const { sendSuccess } = require('../utils/response');

const health = async (req, res, next) => {
    try {
        const queues = await queue.health();
        const realtime = require('../realtime').health();
        return sendSuccess(req, res, { queues, workers: workerMetrics(), realtime });
    } catch (err) { return next(err); }
};

const replay = async (req, res, next) => {
    try {
        const replayed = await queue.replayDeadLetter(Number(req.body && req.body.limit) || 100);
        return sendSuccess(req, res, { replayed });
    } catch (err) { return next(err); }
};

const pause = async (req, res, next) => {
    try { await queue.pause(req.params.name); return sendSuccess(req, res, { paused: req.params.name }); }
    catch (err) { return next(err); }
};
const resume = async (req, res, next) => {
    try { await queue.resume(req.params.name); return sendSuccess(req, res, { resumed: req.params.name }); }
    catch (err) { return next(err); }
};

// Enqueue a notification through the delivery pipeline.
const dispatchNotification = async (req, res, next) => {
    try {
        const data = { tenantId: (req.auth && req.auth.tenantId) || 'T-DEMO', ...req.body };
        const job = await queue.enqueue('notifications', 'notify', data, req.body && req.body.idempotencyKey ? { jobId: req.body.idempotencyKey } : {});
        return sendSuccess(req, res, { jobId: job.id }, 201);
    } catch (err) { return next(err); }
};

module.exports = { health, replay, pause, resume, dispatchNotification };
