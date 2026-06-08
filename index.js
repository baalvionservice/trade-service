'use strict';
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');

const config = require('./config/appConfig');
const { tenantContext, currentTenant } = require('./middleware/tenantContext');
const { tenantConnection } = require('./middleware/tenantConnection');
const requestContext = require('./middleware/requestContext');
const authTrace = require('./observability/authTrace'); // Phase 6E-6 — observability (additive)
const rateLimit = require('./middleware/rateLimit');
const v1Routes = require('./routes/v1');
const { errorHandler, notFoundHandler } = require('./middleware/errorMiddleware');
const db = require('./models');
const providers = require('./providers');
const { metricsMiddleware, metricsHandler } = require('./middleware/metrics');

// ── R1 RLS GUC bridge ───────────────────────────────────────────────────────
// DB-level Row-Level Security (migration 007) is driven by two session GUCs
// (app.current_tenant / app.tenant_bypass). The app-layer ALS hooks inject the
// tenant into the WHERE clause but do NOT set these GUCs, so once the service
// connects as the non-superuser baalvion_app role, RLS would see no tenant and
// fail-closed on managed transactions. This patch stamps the GUCs LOCAL to every
// managed transaction from the request's tenant ALS context. It is a harmless
// no-op under the current owner connection (RLS is bypassed for the owner).
// GUC names mirror @baalvion/tenancy SESSION (and migration 007). Non-transactional
// hot reads are covered by middleware/tenantConnection.js (R1 read-path cutover,
// P1-8), which pins a per-request connection carrying the same GUCs — so the service
// is safe to run as DB_USER=baalvion_app.
const _origTransaction = db.sequelize.transaction.bind(db.sequelize);
db.sequelize.transaction = function tenantAwareTransaction(optsOrFn, maybeFn) {
    const optsFirst = typeof optsOrFn !== 'function';
    const fn = optsFirst ? maybeFn : optsOrFn;
    const opts = optsFirst ? optsOrFn : undefined;
    // Unmanaged transaction (no callback → caller manages commit/rollback): pass through.
    if (typeof fn !== 'function') return _origTransaction(optsOrFn, maybeFn);
    const wrapped = async (t) => {
        const ctx = currentTenant() || {};
        const tenant = ctx.tenantId == null ? '' : String(ctx.tenantId);
        const bypass = ctx.bypass ? 'on' : 'off';
        await db.sequelize.query(
            "SELECT set_config('app.current_tenant', :tenant, true), set_config('app.tenant_bypass', :bypass, true)",
            { replacements: { tenant, bypass }, transaction: t },
        );
        return fn(t);
    };
    return opts ? _origTransaction(opts, wrapped) : _origTransaction(wrapped);
};

const app = express();
const server = http.createServer(app);

app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: config.corsOrigins, credentials: true }));
app.use(express.urlencoded({ extended: true }));
// Capture the raw JSON body so webhook receivers (e.g. /v1/internal/finance-events) can verify
// the HMAC-SHA256 signature over the EXACT bytes the sender signed — re-serializing would not match.
app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(cookieParser());
app.use(tenantContext); // establishes per-request tenant ALS scope for query hooks
// R1 (P1-8): pin a per-request DB connection stamped with the tenant GUCs so
// non-transactional controller reads carry RLS context under baalvion_app. Mounted
// AFTER tenantContext (needs the tenant ctx) and BEFORE the routes that read the DB.
// Env-GATED: dormant by default (no behavioural change) because it switches the
// service to a per-request-transaction model that must be load-tested. Enable it
// ATOMICALLY with the DB_USER=baalvion_app cutover via RLS_READ_PATH=true.
if (config.rlsReadPath) app.use(tenantConnection(db.sequelize));
app.use(requestContext);
app.use(authTrace.middleware('trade-service')); // Phase 6E-6 — logs on response finish
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

// Only auto-boot when run directly (`node index.js`). When imported (tests),
// the app is exported without starting the server / workers / realtime.
if (require.main === module) start();
module.exports = app;
