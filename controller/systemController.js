'use strict';
// Real system telemetry for the infrastructure / resilience / hardening dashboards.
// Everything here is measured live from the running stack — DB latency, Redis, queue depth,
// provider health, and process vitals — NOT simulated.
const db = require('../models');
const { sendSuccess } = require('../utils/response');

let providers, queue, cache;
try { providers = require('../providers'); } catch { providers = null; }
try { queue = require('../queue'); } catch { queue = null; }
try { cache = require('../cache'); } catch { cache = null; }

const REGION = process.env.REGION || 'us-east-1';
const nowIso = () => new Date().toISOString();

// Timed `SELECT 1` → real DB round-trip latency (ms) + connectivity.
async function dbProbe() {
    const t0 = Date.now();
    try {
        await db.sequelize.query('SELECT 1');
        return { connected: true, latencyMs: Date.now() - t0 };
    } catch {
        return { connected: false, latencyMs: Date.now() - t0 };
    }
}

async function gather() {
    const [dbState, qHealth, pHealth] = await Promise.all([
        dbProbe(),
        queue && queue.health ? queue.health().catch(() => null) : Promise.resolve(null),
        providers && providers.healthAll ? providers.healthAll().catch(() => null) : Promise.resolve(null),
    ]);
    const mem = process.memoryUsage();
    const heapPct = Math.round((mem.heapUsed / mem.heapTotal) * 100);
    const cacheHealth = (pHealth && pHealth.cache) || (cache && cache.health ? cache.health() : null);
    return { dbState, qHealth, pHealth, mem, heapPct, cacheHealth };
}

// Aggregate queue job counts → a 0..100 "load" signal.
// queue.health() returns a flat map: { queueName: { waiting, active, completed, ... } }.
function queueLoad(qHealth) {
    if (!qHealth || typeof qHealth !== 'object') return 0;
    let active = 0, waiting = 0;
    for (const k of Object.keys(qHealth)) {
        const q = qHealth[k] || {};
        active += Number(q.active || 0);
        waiting += Number(q.waiting || 0);
    }
    return Math.min(99, active * 8 + waiting * 2);
}

// GET /v1/system/services → live ServiceInstance[] for the resilience/infra topology view.
const services = async (req, res, next) => {
    try {
        const { dbState, qHealth, pHealth, heapPct } = await gather();
        const hb = nowIso();
        const instances = [];

        instances.push({
            id: 'trade-svc-01', serviceName: 'trade-service', region: REGION,
            status: 'active', load: Math.min(99, heapPct), lastHeartbeat: hb, isPrimary: true,
        });
        instances.push({
            id: 'postgres-01', serviceName: 'postgres', region: REGION,
            status: dbState.connected ? 'active' : 'down',
            load: Math.min(99, dbState.latencyMs), lastHeartbeat: hb, isPrimary: true,
        });
        const redisUp = !!(pHealth && pHealth.cache && pHealth.cache.connected);
        instances.push({
            id: 'redis-01', serviceName: 'redis-cache', region: REGION,
            status: redisUp ? 'active' : 'degraded', load: 0, lastHeartbeat: hb, isPrimary: true,
        });
        instances.push({
            id: 'queue-01', serviceName: 'job-queue', region: REGION,
            status: qHealth ? 'active' : 'degraded', load: queueLoad(qHealth), lastHeartbeat: hb, isPrimary: true,
        });

        // Each external provider (fx live, email/sms/etc. simulated until keyed) as its own node.
        if (pHealth && Array.isArray(pHealth.providers)) {
            for (const p of pHealth.providers) {
                instances.push({
                    id: `prov-${p.name}`, serviceName: `provider:${p.name}`, region: REGION,
                    status: p.healthy ? 'active' : (p.mode === 'simulated' ? 'standby' : 'degraded'),
                    load: 0, lastHeartbeat: hb, isPrimary: false,
                });
            }
        }
        return sendSuccess(req, res, instances);
    } catch (err) { return next(err); }
};

// GET /v1/system/pulse → live stabilization telemetry (HardeningPulse shape).
const pulse = async (req, res, next) => {
    try {
        const { dbState, qHealth, heapPct, cacheHealth } = await gather();
        const load = queueLoad(qHealth);
        const errors = (cacheHealth && cacheHealth.errors) || 0;
        const hits = (cacheHealth && cacheHealth.hits) || 0;
        const tension = Math.min(1, errors / Math.max(1, hits + errors));
        const stability = Math.max(0, 100 - (dbState.connected ? 0 : 40) - tension * 20 - Math.max(0, heapPct - 80) / 2);
        return sendSuccess(req, res, {
            loadFactor: +(load / 100).toFixed(2),
            nodeTension: +tension.toFixed(2),
            finalityDelay: dbState.latencyMs,
            stabilityScore: +stability.toFixed(1),
        });
    } catch (err) { return next(err); }
};

// GET /v1/system/readiness → live readiness report (checks + overall score).
const readiness = async (req, res, next) => {
    try {
        const { dbState, qHealth, pHealth, heapPct } = await gather();
        const checks = [
            { name: 'database', ok: dbState.connected, detail: `${dbState.latencyMs}ms` },
            { name: 'cache', ok: !!(pHealth && pHealth.cache && pHealth.cache.connected), detail: 'redis' },
            { name: 'queues', ok: !!qHealth, detail: qHealth ? 'workers up' : 'unavailable' },
            { name: 'memory', ok: heapPct < 90, detail: `${heapPct}% heap` },
            { name: 'fx_provider', ok: !!(pHealth && (pHealth.providers || []).find((p) => p.name === 'fx' && p.healthy)), detail: 'live' },
        ];
        const passed = checks.filter((c) => c.ok).length;
        const score = Math.round((passed / checks.length) * 100);
        return sendSuccess(req, res, {
            generatedAt: nowIso(),
            score,
            status: score >= 80 ? 'READY' : score >= 50 ? 'DEGRADED' : 'NOT_READY',
            checks,
            uptimeSeconds: Math.round(process.uptime()),
        });
    } catch (err) { return next(err); }
};

module.exports = { services, pulse, readiness };
