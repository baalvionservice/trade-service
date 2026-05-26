'use strict';
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');

const config = require('./config/appConfig');
const { tenantContext } = require('./middleware/tenantContext');
const requestContext = require('./middleware/requestContext');
const rateLimit = require('./middleware/rateLimit');
const v1Routes = require('./routes/v1');
const { errorHandler, notFoundHandler } = require('./middleware/errorMiddleware');
const db = require('./models');
const providers = require('./providers');
const { metricsMiddleware, metricsHandler } = require('./middleware/metrics');

const app = express();
const server = http.createServer(app);

app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: config.corsOrigins, credentials: true }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(tenantContext); // establishes per-request tenant ALS scope for query hooks
app.use(requestContext);
app.use(metricsMiddleware);
app.use(rateLimit());

app.get('/', (req, res) => res.json({ service: 'Baalvion Global Trade Infrastructure', version: config.apiVersion }));
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'trade-service', port: config.port, timestamp: new Date().toISOString() }));
// Kubernetes-style probes.
app.get('/health/live', (req, res) => res.json({ status: 'alive', timestamp: new Date().toISOString() }));
app.get('/health/ready', async (req, res) => {
    try {
        await db.sequelize.authenticate();
        return res.json({ status: 'ready', db: 'connected', timestamp: new Date().toISOString() });
    } catch (err) {
        return res.status(503).json({ status: 'not_ready', db: 'unavailable', error: err.message });
    }
});
app.get('/metrics', metricsHandler);

app.use('/v1', v1Routes);
app.use('/api/v1', v1Routes);
app.use(notFoundHandler);
app.use(errorHandler);

const start = async () => {
    try {
        await db.sequelize.authenticate();
        await db.sequelize.query('CREATE SCHEMA IF NOT EXISTS trade');
        // Dev convenience only: create missing base tables. In production set
        // DB_SYNC=false — schema evolution is owned by versioned migrations.
        if (process.env.DB_SYNC !== 'false' && config.env !== 'production') {
            await db.sequelize.sync({ alter: false });
        }
        const { run: runMigrations } = require('./migrate');
        const migrated = await runMigrations();
        console.log(`[trade-service] DB ready (migrations applied this boot: ${migrated.applied.length})`);
        providers.logEnvReport();
        // Start BullMQ workers in-process (set QUEUE_WORKERS=false to run them separately).
        if (process.env.QUEUE_WORKERS !== 'false') {
            require('./queue/workers').startWorkers();
        }
    } catch (err) {
        console.error('[trade-service] DB connection failed:', err.message);
        process.exit(1);
    }
    require('./realtime').initRealtime(server); // attach WebSocket server at /ws
    server.listen(config.port, () => console.log(`[trade-service] running on port ${config.port}`));
};

start();
module.exports = app;
