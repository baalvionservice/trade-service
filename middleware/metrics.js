'use strict';
const client = require('prom-client');

const SERVICE_NAME = process.env.SERVICE_NAME || 'trade-service';

const register = client.register;
register.setDefaultLabels({ service: SERVICE_NAME });
client.collectDefaultMetrics({ register, prefix: 'baalvion_node_' });

const httpRequestsTotal = new client.Counter({
    name: 'baalvion_http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'route', 'status', 'service'],
    registers: [register],
});

const httpRequestDuration = new client.Histogram({
    name: 'baalvion_http_request_duration_ms',
    help: 'HTTP request duration in milliseconds',
    labelNames: ['method', 'route', 'status', 'service'],
    buckets: [10, 50, 100, 200, 500, 1000, 2000, 5000],
    registers: [register],
});

const httpActiveRequests = new client.Gauge({
    name: 'baalvion_http_active_requests',
    help: 'Currently active HTTP requests',
    labelNames: ['service'],
    registers: [register],
});

function metricsMiddleware(req, res, next) {
    if (req.path === '/metrics') return next();
    const start = Date.now();
    httpActiveRequests.inc({ service: SERVICE_NAME });
    res.on('finish', () => {
        const route = req.route ? req.baseUrl + req.route.path : req.path;
        const labels = {
            method: req.method,
            route: route.replace(/\/[0-9a-f-]{8,}/gi, '/:id'),
            status: String(res.statusCode),
            service: SERVICE_NAME,
        };
        httpRequestsTotal.inc(labels);
        httpRequestDuration.observe(labels, Date.now() - start);
        httpActiveRequests.dec({ service: SERVICE_NAME });
    });
    next();
}

async function metricsHandler(req, res) {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
}

module.exports = { metricsMiddleware, metricsHandler, register };
