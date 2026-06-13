'use strict';
/**
 * Logistics Optimization Agent — LANE NETWORK SSOT (Prompt 14).
 *
 * PURE: no DB, no network. The built-in transport graph the route builder searches:
 * a set of HUBS (ports / airports / inland gateways) with coordinates, and the LANES
 * (directed-but-symmetric edges) that connect them per mode with a measured distance,
 * baseline transit, and a cost-rate multiplier the carrier-rate layer prices against.
 *
 * The network is deliberately small but realistic — the major gateways across the
 * platform's five markets (US / UK / AE / IN / SG) plus the China / EU lanes that
 * actually carry their trade. It is the single source of geographic truth; everything
 * else (route enumeration, carrier selection, scoring) is computed from it.
 *
 * PLUGGABLE: `registerLaneProvider()` lets a real lane/rate feed (sea-rates,
 * flight-schedule, road-network APIs) override the built-in graph at runtime without
 * touching the engine — the API INTEGRATION LAYER the prompt asks for. Providers are
 * consulted first; the built-in graph is the deterministic fallback.
 */

const { MODE, num } = require('./schema');

// ── Hubs — code → { name, country, coords, modes it serves }. ────────────────
// Coordinates are [lat, lon]; used for great-circle distance + a deterministic
// nearest-hub geocoder. `gateway` marks a country's default entry/exit hub.
const HUBS = Object.freeze({
    // — Asia —
    CNSHA: { name: 'Shanghai', country: 'CN', coords: [31.23, 121.47], modes: [MODE.OCEAN, MODE.AIR, MODE.RAIL], gateway: true },
    CNSZX: { name: 'Shenzhen', country: 'CN', coords: [22.54, 114.06], modes: [MODE.OCEAN, MODE.AIR] },
    HKHKG: { name: 'Hong Kong', country: 'HK', coords: [22.31, 113.91], modes: [MODE.OCEAN, MODE.AIR], gateway: true },
    SGSIN: { name: 'Singapore', country: 'SG', coords: [1.35, 103.82], modes: [MODE.OCEAN, MODE.AIR, MODE.ROAD], gateway: true },
    INNSA: { name: 'Nhava Sheva (Mumbai)', country: 'IN', coords: [18.95, 72.95], modes: [MODE.OCEAN, MODE.ROAD], gateway: true },
    INMAA: { name: 'Chennai', country: 'IN', coords: [13.08, 80.27], modes: [MODE.OCEAN, MODE.AIR, MODE.ROAD] },
    INDEL: { name: 'Delhi', country: 'IN', coords: [28.61, 77.21], modes: [MODE.AIR, MODE.ROAD, MODE.RAIL] },
    AEJEA: { name: 'Jebel Ali (Dubai)', country: 'AE', coords: [25.01, 55.06], modes: [MODE.OCEAN, MODE.AIR, MODE.ROAD], gateway: true },
    // — Europe —
    NLRTM: { name: 'Rotterdam', country: 'NL', coords: [51.95, 4.14], modes: [MODE.OCEAN, MODE.ROAD, MODE.RAIL], gateway: true },
    DEHAM: { name: 'Hamburg', country: 'DE', coords: [53.55, 9.99], modes: [MODE.OCEAN, MODE.ROAD, MODE.RAIL], gateway: true },
    GBFXT: { name: 'Felixstowe', country: 'GB', coords: [51.96, 1.35], modes: [MODE.OCEAN, MODE.ROAD], gateway: true },
    GBLHR: { name: 'London Heathrow', country: 'GB', coords: [51.47, -0.45], modes: [MODE.AIR, MODE.EXPRESS, MODE.ROAD] },
    // — North America —
    USNYC: { name: 'New York / Newark', country: 'US', coords: [40.69, -74.18], modes: [MODE.OCEAN, MODE.AIR, MODE.ROAD], gateway: true },
    USLAX: { name: 'Los Angeles / Long Beach', country: 'US', coords: [33.74, -118.26], modes: [MODE.OCEAN, MODE.AIR, MODE.ROAD] },
    USCHI: { name: 'Chicago', country: 'US', coords: [41.88, -87.63], modes: [MODE.AIR, MODE.ROAD, MODE.RAIL] },
});

// City → hub aliases so a request given by city resolves deterministically before
// falling back to the nearest-coordinate geocoder.
const CITY_ALIASES = Object.freeze({
    shanghai: 'CNSHA', shenzhen: 'CNSZX', guangzhou: 'CNSZX', 'hong kong': 'HKHKG',
    singapore: 'SGSIN', mumbai: 'INNSA', 'navi mumbai': 'INNSA', chennai: 'INMAA',
    delhi: 'INDEL', 'new delhi': 'INDEL', dubai: 'AEJEA', 'abu dhabi': 'AEJEA',
    rotterdam: 'NLRTM', amsterdam: 'NLRTM', hamburg: 'DEHAM', berlin: 'DEHAM',
    felixstowe: 'GBFXT', london: 'GBLHR', 'new york': 'USNYC', newark: 'USNYC',
    'los angeles': 'USLAX', 'long beach': 'USLAX', chicago: 'USCHI',
});

// Country → its default gateway hub (used when a request gives only a country).
const COUNTRY_GATEWAY = (() => {
    const map = {};
    for (const [code, h] of Object.entries(HUBS)) {
        if (h.gateway && !map[h.country]) map[h.country] = code;
    }
    return Object.freeze(map);
})();

/**
 * Built-in lanes. Each lane: { from, to, mode, distance_km, transit_days,
 * cost_rate }. cost_rate is the per-(kg·1000km)-ish multiplier the carrier-rate
 * layer prices against (ocean cheap, air/express dear). Lanes are symmetric — the
 * loader materializes both directions.
 */
const LANE_DEFS = [
    // Trans-Pacific (Asia → US West, ocean + air)
    { from: 'CNSHA', to: 'USLAX', mode: MODE.OCEAN, distance_km: 10400, transit_days: 18, cost_rate: 0.9 },
    { from: 'CNSHA', to: 'USLAX', mode: MODE.AIR, distance_km: 10400, transit_days: 4, cost_rate: 9.5 },
    { from: 'CNSZX', to: 'USLAX', mode: MODE.OCEAN, distance_km: 11600, transit_days: 19, cost_rate: 0.92 },
    { from: 'HKHKG', to: 'USLAX', mode: MODE.AIR, distance_km: 11600, transit_days: 4, cost_rate: 9.6 },
    // Asia → US East (ocean via Panama, air)
    { from: 'CNSHA', to: 'USNYC', mode: MODE.OCEAN, distance_km: 20300, transit_days: 30, cost_rate: 1.05 },
    { from: 'CNSHA', to: 'USNYC', mode: MODE.AIR, distance_km: 11900, transit_days: 5, cost_rate: 10.2 },
    // Asia → Europe (ocean via Suez, air, rail land-bridge)
    { from: 'CNSHA', to: 'NLRTM', mode: MODE.OCEAN, distance_km: 19500, transit_days: 32, cost_rate: 0.88 },
    { from: 'CNSHA', to: 'DEHAM', mode: MODE.OCEAN, distance_km: 20100, transit_days: 33, cost_rate: 0.9 },
    { from: 'CNSHA', to: 'DEHAM', mode: MODE.RAIL, distance_km: 11000, transit_days: 18, cost_rate: 2.2 },
    { from: 'CNSHA', to: 'NLRTM', mode: MODE.AIR, distance_km: 9200, transit_days: 4, cost_rate: 9.0 },
    // Asia hubs ↔ Singapore (feeder / transshipment)
    { from: 'CNSHA', to: 'SGSIN', mode: MODE.OCEAN, distance_km: 4500, transit_days: 8, cost_rate: 0.8 },
    { from: 'CNSZX', to: 'SGSIN', mode: MODE.OCEAN, distance_km: 2600, transit_days: 5, cost_rate: 0.78 },
    { from: 'HKHKG', to: 'SGSIN', mode: MODE.OCEAN, distance_km: 2570, transit_days: 5, cost_rate: 0.78 },
    { from: 'HKHKG', to: 'SGSIN', mode: MODE.AIR, distance_km: 2570, transit_days: 2, cost_rate: 8.0 },
    // Singapore as the great transshipment hub
    { from: 'SGSIN', to: 'NLRTM', mode: MODE.OCEAN, distance_km: 15300, transit_days: 24, cost_rate: 0.85 },
    { from: 'SGSIN', to: 'AEJEA', mode: MODE.OCEAN, distance_km: 5800, transit_days: 9, cost_rate: 0.82 },
    { from: 'SGSIN', to: 'INNSA', mode: MODE.OCEAN, distance_km: 4000, transit_days: 7, cost_rate: 0.8 },
    { from: 'SGSIN', to: 'USLAX', mode: MODE.OCEAN, distance_km: 14100, transit_days: 22, cost_rate: 0.9 },
    // India ↔ Gulf ↔ Europe
    { from: 'INNSA', to: 'AEJEA', mode: MODE.OCEAN, distance_km: 1900, transit_days: 4, cost_rate: 0.75 },
    { from: 'INNSA', to: 'NLRTM', mode: MODE.OCEAN, distance_km: 11800, transit_days: 21, cost_rate: 0.86 },
    { from: 'INMAA', to: 'SGSIN', mode: MODE.OCEAN, distance_km: 3000, transit_days: 6, cost_rate: 0.8 },
    { from: 'INDEL', to: 'AEJEA', mode: MODE.AIR, distance_km: 2200, transit_days: 2, cost_rate: 8.2 },
    { from: 'INNSA', to: 'INDEL', mode: MODE.ROAD, distance_km: 1400, transit_days: 3, cost_rate: 1.6 },
    { from: 'INNSA', to: 'INDEL', mode: MODE.RAIL, distance_km: 1400, transit_days: 4, cost_rate: 0.9 },
    // Gulf → Europe / US
    { from: 'AEJEA', to: 'NLRTM', mode: MODE.OCEAN, distance_km: 11200, transit_days: 19, cost_rate: 0.85 },
    { from: 'AEJEA', to: 'GBFXT', mode: MODE.OCEAN, distance_km: 11600, transit_days: 20, cost_rate: 0.86 },
    { from: 'AEJEA', to: 'USNYC', mode: MODE.AIR, distance_km: 11000, transit_days: 5, cost_rate: 10.0 },
    // Intra-Europe (road / rail / ocean feeder)
    { from: 'NLRTM', to: 'DEHAM', mode: MODE.ROAD, distance_km: 480, transit_days: 1, cost_rate: 1.4 },
    { from: 'NLRTM', to: 'DEHAM', mode: MODE.RAIL, distance_km: 480, transit_days: 2, cost_rate: 0.9 },
    { from: 'NLRTM', to: 'GBFXT', mode: MODE.OCEAN, distance_km: 360, transit_days: 2, cost_rate: 0.7 },
    { from: 'GBFXT', to: 'GBLHR', mode: MODE.ROAD, distance_km: 130, transit_days: 1, cost_rate: 1.3 },
    { from: 'NLRTM', to: 'GBLHR', mode: MODE.ROAD, distance_km: 420, transit_days: 1, cost_rate: 1.5 },
    // Transatlantic (Europe ↔ US)
    { from: 'NLRTM', to: 'USNYC', mode: MODE.OCEAN, distance_km: 6000, transit_days: 11, cost_rate: 0.84 },
    { from: 'DEHAM', to: 'USNYC', mode: MODE.OCEAN, distance_km: 6200, transit_days: 12, cost_rate: 0.85 },
    { from: 'GBLHR', to: 'USNYC', mode: MODE.AIR, distance_km: 5550, transit_days: 3, cost_rate: 9.8 },
    { from: 'GBLHR', to: 'USNYC', mode: MODE.EXPRESS, distance_km: 5550, transit_days: 2, cost_rate: 13.0 },
    // Intra-US (road / rail / air)
    { from: 'USNYC', to: 'USCHI', mode: MODE.ROAD, distance_km: 1270, transit_days: 2, cost_rate: 1.5 },
    { from: 'USNYC', to: 'USCHI', mode: MODE.RAIL, distance_km: 1270, transit_days: 3, cost_rate: 0.95 },
    { from: 'USLAX', to: 'USCHI', mode: MODE.RAIL, distance_km: 3240, transit_days: 5, cost_rate: 1.0 },
    { from: 'USLAX', to: 'USNYC', mode: MODE.ROAD, distance_km: 4500, transit_days: 6, cost_rate: 1.6 },
    { from: 'USLAX', to: 'USNYC', mode: MODE.AIR, distance_km: 3940, transit_days: 2, cost_rate: 8.5 },
];

/** Materialize the symmetric adjacency list once. */
function buildLanes(defs) {
    const lanes = [];
    for (const d of defs) {
        const base = {
            mode: d.mode,
            distance_km: num(d.distance_km),
            transit_days: Math.max(1, Math.round(num(d.transit_days))),
            cost_rate: num(d.cost_rate) || 1,
        };
        lanes.push({ from: d.from, to: d.to, ...base });
        lanes.push({ from: d.to, to: d.from, ...base });
    }
    return lanes;
}

const BUILTIN_LANES = Object.freeze(buildLanes(LANE_DEFS));

// ── Pluggable lane providers (the API integration seam). ─────────────────────
// A provider is { name, lanesFrom(hubCode, ctx) -> [laneDef] }. Registered providers
// are consulted FIRST; their lanes augment/override the built-in graph for that hub.
const _providers = [];
function registerLaneProvider(provider) {
    if (!provider || typeof provider.lanesFrom !== 'function') {
        throw new Error('registerLaneProvider(): provider must implement lanesFrom(hub, ctx)');
    }
    _providers.push(provider);
    return () => {
        const i = _providers.indexOf(provider);
        if (i >= 0) _providers.splice(i, 1);
    };
}
function clearLaneProviders() { _providers.length = 0; }

// ── Geo helpers ──────────────────────────────────────────────────────────────
const R_KM = 6371;
const toRad = (d) => (d * Math.PI) / 180;
/** Great-circle distance in km between two [lat,lon] points. */
function haversineKm(a, b) {
    if (!a || !b) return 0;
    const dLat = toRad(b[0] - a[0]);
    const dLon = toRad(b[1] - a[1]);
    const lat1 = toRad(a[0]); const lat2 = toRad(b[0]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return Math.round(2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h))));
}

function getHub(code) {
    return code ? HUBS[String(code).toUpperCase()] || null : null;
}

/**
 * Resolve a place ({ hub, city, country }) to a hub code:
 *   1. explicit hub (if known)   2. city alias   3. country gateway
 *   4. nearest hub by coords (only when the place itself carries coords)
 * Returns { hub, resolvedBy } or { hub: null } when nothing matches.
 */
function resolveHub(place = {}) {
    const p = place || {};
    if (p.hub && HUBS[p.hub]) return { hub: p.hub, resolvedBy: 'explicit' };
    if (p.city) {
        const alias = CITY_ALIASES[p.city.toLowerCase()];
        if (alias) return { hub: alias, resolvedBy: 'city' };
    }
    if (p.country && COUNTRY_GATEWAY[p.country]) {
        return { hub: COUNTRY_GATEWAY[p.country], resolvedBy: 'country_gateway' };
    }
    if (Array.isArray(p.coords)) {
        let best = null; let bestD = Infinity;
        for (const [code, h] of Object.entries(HUBS)) {
            const d = haversineKm(p.coords, h.coords);
            if (d < bestD) { bestD = d; best = code; }
        }
        if (best) return { hub: best, resolvedBy: 'nearest' };
    }
    return { hub: null, resolvedBy: null };
}

/**
 * All outbound lanes from a hub, honoring the allowed-mode filter. Provider lanes are
 * merged in front of the built-in lanes (provider wins on a {to,mode} collision).
 */
function lanesFrom(hubCode, { allowedModes = [], ctx = {} } = {}) {
    const code = String(hubCode || '').toUpperCase();
    const allow = Array.isArray(allowedModes) && allowedModes.length ? new Set(allowedModes) : null;

    const provided = [];
    for (const prov of _providers) {
        try {
            const rows = prov.lanesFrom(code, ctx) || [];
            for (const r of rows) {
                if (r && r.from && r.to && r.mode) {
                    provided.push({
                        from: String(r.from).toUpperCase(), to: String(r.to).toUpperCase(), mode: r.mode,
                        distance_km: num(r.distance_km), transit_days: Math.max(1, Math.round(num(r.transit_days))),
                        cost_rate: num(r.cost_rate) || 1, source: prov.name || 'provider',
                    });
                }
            }
        } catch { /* a failing provider never sinks the search — built-in graph covers it */ }
    }

    const builtin = BUILTIN_LANES.filter((l) => l.from === code).map((l) => ({ ...l, source: 'builtin' }));

    const seen = new Set();
    const out = [];
    for (const lane of [...provided, ...builtin]) {
        if (allow && !allow.has(lane.mode)) continue;
        const key = `${lane.to}:${lane.mode}`;
        if (seen.has(key)) continue; // provider already supplied this {to,mode}
        seen.add(key);
        out.push(lane);
    }
    return out;
}

/** Does a hub exist (built-in)? */
function hubExists(code) { return !!getHub(code); }

module.exports = {
    HUBS,
    COUNTRY_GATEWAY,
    CITY_ALIASES,
    BUILTIN_LANES,
    getHub,
    hubExists,
    resolveHub,
    lanesFrom,
    haversineKm,
    registerLaneProvider,
    clearLaneProviders,
};
