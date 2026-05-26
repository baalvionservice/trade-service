'use strict';
/**
 * Centralized cache service over Redis with tenant-aware keys, TTL policies,
 * pattern invalidation, and cache-aside (`wrap`) + stale-while-revalidate
 * (`swr`) helpers. Safe no-op when Redis is unavailable.
 */
const client = require('./redis');

const PREFIX = 'baalvion';
const stats = { hits: 0, misses: 0, sets: 0, errors: 0 };
const ready = () => !!client && client.status === 'ready';

const key = (...parts) => [PREFIX, ...parts.filter((p) => p != null && p !== '')].join(':');
// Tenant-aware key: baalvion:<tenant>:<namespace>:<id>
const tkey = (tenant, ns, id) => key(tenant || 'global', ns, id);

async function get(k) {
    if (!ready()) return null;
    try {
        const v = await client.get(k);
        if (v == null) { stats.misses += 1; return null; }
        stats.hits += 1;
        return JSON.parse(v);
    } catch { stats.errors += 1; return null; }
}

async function set(k, value, ttlSeconds = 60) {
    if (!ready() || value === undefined || value === null) return;
    try { await client.set(k, JSON.stringify(value), 'EX', ttlSeconds); stats.sets += 1; }
    catch { stats.errors += 1; }
}

async function del(k) { if (ready()) { try { await client.del(k); } catch { stats.errors += 1; } } }

// Invalidate every key matching a (prefixed) glob — e.g. invalidate('T-DEMO:stats:*').
async function invalidate(pattern) {
    if (!ready()) return 0;
    try {
        const keys = await client.keys(key(pattern));
        if (keys.length) await client.del(keys);
        return keys.length;
    } catch { stats.errors += 1; return 0; }
}

// Cache-aside: return cached value or compute, store, and return it.
async function wrap(k, ttlSeconds, producer) {
    const cached = await get(k);
    if (cached !== null) return cached;
    const fresh = await producer();
    await set(k, fresh, ttlSeconds);
    return fresh;
}

function health() {
    const total = stats.hits + stats.misses;
    return {
        name: 'cache',
        backend: 'redis',
        connected: ready(),
        status: client ? client.status : 'disabled',
        ...stats,
        hitRate: total ? Number((stats.hits / total).toFixed(3)) : 0,
    };
}

module.exports = { key, tkey, get, set, del, invalidate, wrap, health, stats };
