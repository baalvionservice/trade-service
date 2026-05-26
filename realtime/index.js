'use strict';
/**
 * Enterprise realtime layer (WebSocket).
 *  - Authenticated on connect (JWT in ?token=), tenant/org/role context.
 *  - Room model with participant/tenant authorization (deal/org/shipment/tenant).
 *  - Heartbeat ping/pong with dead-connection reaping.
 *  - Redis pub/sub fanout (multi-instance scale) + per-room replay buffer for
 *    missed-event recovery on reconnect. Falls back to in-process fanout if
 *    Redis is unavailable.
 */
const url = require('url');
const { WebSocketServer } = require('ws');
const IORedis = require('ioredis');
const jwtserver = require('../utils/jwtserver');
const db = require('../models');

const REPLAY_MAX = 50;
const HEARTBEAT_MS = 30000;

const rooms = new Map();          // room -> Set<ws>
const metrics = { connections: 0, rooms: 0, published: 0, delivered: 0, rejected: 0 };
let seq = 0;
const INSTANCE = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`; // for pub/sub dedup

// Dedicated pub/sub connections (independent of the cache/queue clients).
const redisOpts = { maxRetriesPerRequest: null, enableOfflineQueue: false, lazyConnect: false };
let pub = null; let sub = null; let redisOK = false;
try {
    const make = () => (process.env.REDIS_URL ? new IORedis(process.env.REDIS_URL, redisOpts) : new IORedis({ host: process.env.REDIS_HOST || 'localhost', port: Number(process.env.REDIS_PORT || 6379), ...redisOpts }));
    pub = make(); sub = make();
    pub.on('ready', () => { redisOK = true; });
    pub.on('error', () => { redisOK = false; });
    sub.on('error', () => {});
    sub.subscribe('rt:fanout').catch(() => {});
    // Only deliver messages that originated on ANOTHER instance (local instance
    // already delivered in-process); prevents double-delivery on single node.
    sub.on('message', (_ch, payload) => { try { const m = JSON.parse(payload); if (m.origin !== INSTANCE) localDeliver(m); } catch { /* ignore */ } });
} catch { pub = null; sub = null; }

function roomReplayKey(room) { return `rt:replay:${room}`; }

async function storeReplay(msg) {
    if (!pub || !redisOK) return;
    try {
        await pub.multi().lpush(roomReplayKey(msg.room), JSON.stringify(msg)).ltrim(roomReplayKey(msg.room), 0, REPLAY_MAX - 1).expire(roomReplayKey(msg.room), 86400).exec();
    } catch { /* best-effort */ }
}

async function getReplay(room, since) {
    if (!pub || !redisOK) return [];
    try {
        const raw = await pub.lrange(roomReplayKey(room), 0, REPLAY_MAX - 1);
        const events = raw.map((r) => JSON.parse(r)).reverse(); // oldest -> newest
        return since ? events.filter((e) => e.ts > Number(since)) : events;
    } catch { return []; }
}

// Deliver to LOCAL subscribers only (called once per event via the chosen path).
function localDeliver(msg) {
    const set = rooms.get(msg.room);
    if (!set) return;
    const data = JSON.stringify({ type: 'event', room: msg.room, event: msg.event, data: msg.data, ts: msg.ts, id: msg.id });
    for (const ws of set) {
        if (ws.readyState === ws.OPEN) { ws.send(data); metrics.delivered += 1; }
    }
}

// Publish an event to a room: store for replay, deliver to local subscribers
// immediately, and fan out to other instances via Redis pub/sub.
async function publish(room, event, data) {
    const msg = { room, event, data, ts: Date.now(), id: (seq += 1), origin: INSTANCE };
    metrics.published += 1;
    await storeReplay(msg);
    localDeliver(msg); // in-process subscribers (reliable, no Redis dependency)
    if (pub && redisOK) { try { await pub.publish('rt:fanout', JSON.stringify(msg)); } catch { /* other instances miss this one */ } }
}

// --- Room authorization -----------------------------------------------------
async function canJoin(ctx, room) {
    if (!room || typeof room !== 'string') return false;
    if (ctx.role === 'admin') return true;
    const [kind, id] = room.split(':');
    if (kind === 'org') return ctx.orgCode && ctx.orgCode === id;
    if (kind === 'tenant') return ctx.tenantId && ctx.tenantId === id;
    if (kind === 'deal') {
        const deal = await db.Deal.findByPk(id);
        return !!deal && (deal.buyer_org_id === ctx.orgCode || deal.seller_org_id === ctx.orgCode);
    }
    if (kind === 'shipment') {
        const s = await db.Shipment.findByPk(id);
        return !!s && s.tenant_id === ctx.tenantId;
    }
    return false;
}

function joinRoom(ws, room) {
    if (!rooms.has(room)) { rooms.set(room, new Set()); metrics.rooms = rooms.size; }
    rooms.get(room).add(ws);
    ws.rooms.add(room);
}
function leaveRoom(ws, room) {
    const set = rooms.get(room);
    if (set) { set.delete(ws); if (!set.size) { rooms.delete(room); metrics.rooms = rooms.size; } }
    ws.rooms.delete(room);
}
function leaveAll(ws) { for (const r of [...ws.rooms]) leaveRoom(ws, r); }

function initRealtime(httpServer) {
    const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

    wss.on('connection', (ws, req) => {
        const { query } = url.parse(req.url, true);
        const token = query.token;
        let ctx;
        try {
            const d = jwtserver.verifyAccessToken(String(token || ''));
            ctx = { userId: d.id, tenantId: d.tenantId || null, orgCode: d.orgCode || null, role: d.role || 'client' };
        } catch {
            metrics.rejected += 1;
            ws.close(4401, 'unauthorized');
            return;
        }
        ws.ctx = ctx; ws.rooms = new Set(); ws.isAlive = true;
        metrics.connections += 1;
        ws.send(JSON.stringify({ type: 'welcome', tenantId: ctx.tenantId, orgCode: ctx.orgCode }));

        ws.on('pong', () => { ws.isAlive = true; });
        ws.on('message', async (raw) => {
            let m; try { m = JSON.parse(raw.toString()); } catch { return; }
            if (m.type === 'ping') return ws.send(JSON.stringify({ type: 'pong' }));
            if (m.type === 'subscribe') {
                const allowed = await canJoin(ctx, m.room);
                if (!allowed) { metrics.rejected += 1; return ws.send(JSON.stringify({ type: 'error', room: m.room, error: 'forbidden' })); }
                joinRoom(ws, m.room);
                const missed = await getReplay(m.room, m.since);
                ws.send(JSON.stringify({ type: 'subscribed', room: m.room, replay: missed.length }));
                for (const e of missed) ws.send(JSON.stringify({ type: 'event', room: e.room, event: e.event, data: e.data, ts: e.ts, id: e.id, replayed: true }));
            } else if (m.type === 'unsubscribe') {
                leaveRoom(ws, m.room);
                ws.send(JSON.stringify({ type: 'unsubscribed', room: m.room }));
            }
        });
        ws.on('close', () => { leaveAll(ws); metrics.connections = Math.max(0, metrics.connections - 1); });
        ws.on('error', () => { leaveAll(ws); });
    });

    const hb = setInterval(() => {
        wss.clients.forEach((ws) => {
            if (ws.isAlive === false) { leaveAll(ws); return ws.terminate(); }
            ws.isAlive = false;
            try { ws.ping(); } catch { /* ignore */ }
        });
    }, HEARTBEAT_MS);
    wss.on('close', () => clearInterval(hb));

    // eslint-disable-next-line no-console
    console.log('[realtime] WebSocket server attached at /ws');
    return wss;
}

const health = () => ({ name: 'realtime', connections: metrics.connections, rooms: metrics.rooms, redis: redisOK, ...metrics });

module.exports = { initRealtime, publish, health, metrics };
