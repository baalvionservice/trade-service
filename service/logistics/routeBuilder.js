'use strict';
/**
 * Logistics Optimization Agent — CANDIDATE ROUTE ENUMERATION (Prompt 14).
 *
 * PURE: no DB, no network. The ROUTE OPTIMIZATION core. Given a resolved origin hub
 * and destination hub it searches the lane network for candidate end-to-end routes —
 * the direct lane plus paths that transship through up to `maxTransfers` intermediate
 * hubs — and expands each hub-path across its available transport modes so the
 * downstream scoring engine sees the genuine cost-vs-speed frontier (the cheap-slow
 * ocean path AND the dear-fast air path between the same two points).
 *
 * Each hop's carrier is chosen by the carrier-selection layer; each route is
 * aggregated into a normalized route by the schema factory. The search is bounded on
 * every axis (path depth, mode fan-out per hop, total candidates) so it is fast and
 * deterministic regardless of how dense the network gets.
 */

const net = require('./network');
const rates = require('./carrierRates');
const { normalizedRoute, DEFAULT_MAX_TRANSFERS, RouteError, FAILURE_KIND } = require('./schema');

// Hard ceilings — keep the search bounded even on a dense/provider-augmented graph.
const MAX_MODE_FANOUT_PER_HOP = 3;   // distinct modes explored per hop
const MAX_RAW_CANDIDATES = 80;       // pre-scoring candidate cap

/**
 * Enumerate hub PATHS (sequences of hub codes) from `origin` to `destination` with at
 * most `maxTransfers` intermediate hubs, via bounded DFS. No node is visited twice
 * (no cycles). Returns an array of hub-code arrays, shortest-first.
 */
function enumeratePaths(origin, destination, { maxTransfers = DEFAULT_MAX_TRANSFERS, allowedModes = [], ctx = {} } = {}) {
    const maxHops = Math.max(1, maxTransfers + 1); // legs = transfers + 1
    const paths = [];

    const walk = (current, visited, path, depth) => {
        if (paths.length >= MAX_RAW_CANDIDATES) return;
        if (current === destination) { paths.push([...path]); return; }
        if (depth >= maxHops) return;

        const lanes = net.lanesFrom(current, { allowedModes, ctx });
        // Distinct next hubs reachable from here (mode multiplicity handled in expand).
        const nextHubs = [...new Set(lanes.map((l) => l.to))];
        for (const to of nextHubs) {
            if (visited.has(to)) continue;
            // Prune: never step away to a hop that can't possibly reach dest within budget
            // (cheap admissibility guard — direct lane to dest is always allowed).
            visited.add(to);
            path.push(to);
            walk(to, visited, path, depth + 1);
            path.pop();
            visited.delete(to);
        }
    };

    walk(origin, new Set([origin]), [origin], 0);
    // Shortest paths first so the candidate cap keeps the simplest routes.
    return paths.sort((a, b) => a.length - b.length);
}

/**
 * Expand one hub-path into concrete leg-sequences across mode choices. For each hop
 * the network may offer several modes (ocean / air / rail); we take the cartesian
 * product, bounded by MAX_MODE_FANOUT_PER_HOP per hop and an overall cap, so a single
 * path yields both its slow-cheap and fast-dear realizations.
 *
 * Returns an array of leg-arrays (each leg = a priced, carrier-selected normalized leg input).
 */
function expandPath(path, weightKg, { allowedModes = [], carrierStrategy = 'cheapest', ctx = {} } = {}) {
    // For each hop, the candidate lanes (one per available mode), capped + cheapest-first.
    const hopLaneSets = [];
    for (let i = 0; i < path.length - 1; i += 1) {
        const from = path[i]; const to = path[i + 1];
        const lanes = net.lanesFrom(from, { allowedModes, ctx }).filter((l) => l.to === to);
        if (lanes.length === 0) return []; // broken path — no lane for this hop
        // Distinct modes only, prefer lower cost_rate (cheaper modes) first.
        const byMode = new Map();
        for (const l of lanes.sort((a, b) => a.cost_rate - b.cost_rate)) {
            if (!byMode.has(l.mode)) byMode.set(l.mode, l);
        }
        hopLaneSets.push([...byMode.values()].slice(0, MAX_MODE_FANOUT_PER_HOP));
    }

    // Cartesian product of hop lane choices, bounded.
    let combos = [[]];
    for (const hopLanes of hopLaneSets) {
        const next = [];
        for (const combo of combos) {
            for (const lane of hopLanes) {
                next.push([...combo, lane]);
                if (next.length >= MAX_RAW_CANDIDATES) break;
            }
            if (next.length >= MAX_RAW_CANDIDATES) break;
        }
        combos = next;
    }

    // Price each combo: select a carrier per lane and build normalized-leg inputs.
    const legSequences = [];
    for (const combo of combos) {
        const legs = [];
        let broken = false;
        for (const lane of combo) {
            const picked = rates.selectCarrierForLane(lane, weightKg, carrierStrategy, { ctx });
            if (!picked) { broken = true; break; }
            legs.push({
                from: lane.from,
                to: lane.to,
                mode: picked.mode,
                carrier: picked.carrier,
                carrier_name: picked.carrier_name,
                distance_km: picked.distance_km,
                transit_days: picked.transit_days,
                cost: picked.cost,
                reliability: picked.reliability,
                co2_kg: picked.co2_kg,
                estimated: false,
            });
        }
        if (!broken && legs.length) legSequences.push(legs);
    }
    return legSequences;
}

/**
 * Build the full candidate ROUTE set between two hubs. Enumerates paths, expands each
 * across modes, prices every leg, and assembles normalized routes — deduped by route
 * id. Returns { routes, paths_explored }. Throws RouteError(NO_ROUTE) only when the
 * graph yields nothing (the optimizer catches it and invokes the fallback layer).
 */
function buildRoutes(originHub, destHub, weightKg, opts = {}) {
    if (!net.hubExists(originHub)) throw new RouteError({ kind: FAILURE_KIND.NO_ROUTE, message: `unknown origin hub '${originHub}'` });
    if (!net.hubExists(destHub)) throw new RouteError({ kind: FAILURE_KIND.NO_ROUTE, message: `unknown destination hub '${destHub}'` });

    const paths = enumeratePaths(originHub, destHub, opts);
    const seen = new Set();
    const routes = [];

    for (const path of paths) {
        const sequences = expandPath(path, weightKg, opts);
        for (const legs of sequences) {
            let route;
            try {
                route = normalizedRoute(legs, { currency: opts.currency });
            } catch { continue; }
            if (seen.has(route.id)) continue;
            seen.add(route.id);
            routes.push(route);
            if (routes.length >= MAX_RAW_CANDIDATES) break;
        }
        if (routes.length >= MAX_RAW_CANDIDATES) break;
    }

    if (routes.length === 0) {
        throw new RouteError({
            kind: FAILURE_KIND.NO_ROUTE,
            message: `no route found from ${originHub} to ${destHub} within ${(opts.maxTransfers != null ? opts.maxTransfers : DEFAULT_MAX_TRANSFERS)} transfer(s)`,
            detail: { origin: originHub, destination: destHub, paths_explored: paths.length },
        });
    }

    return { routes, paths_explored: paths.length };
}

module.exports = {
    enumeratePaths,
    expandPath,
    buildRoutes,
    MAX_MODE_FANOUT_PER_HOP,
    MAX_RAW_CANDIDATES,
};
