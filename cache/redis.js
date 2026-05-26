'use strict';
/**
 * Shared ioredis client. Fails fast (no offline queue) so that if Redis is
 * unavailable the cache layer degrades to a no-op rather than hanging requests.
 * Config: REDIS_URL, or REDIS_HOST/REDIS_PORT (default localhost:6379).
 */
const Redis = require('ioredis');

const opts = { maxRetriesPerRequest: 2, enableOfflineQueue: false, lazyConnect: false, retryStrategy: (n) => Math.min(n * 200, 2000) };

let client = null;
try {
    client = process.env.REDIS_URL
        ? new Redis(process.env.REDIS_URL, opts)
        : new Redis({ host: process.env.REDIS_HOST || 'localhost', port: Number(process.env.REDIS_PORT || 6379), ...opts });
    client.on('error', () => { /* swallow — cache degrades to no-op; logged via health */ });
} catch {
    client = null;
}

module.exports = client;
