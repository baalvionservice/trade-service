'use strict';
/**
 * Carrier shipment-tracking provider (Logistics #2). Live mode (TRACKING_API_KEY set) would call a
 * carrier aggregator (e.g. project44 / Aftership / a carrier's own API); until a key is supplied it
 * runs a deterministic SIMULATED tracker that advances a shipment through a plausible transit
 * lifecycle based on elapsed time vs its ETA. Pure + side-effect free — the controller persists.
 */

// Ordered transit lifecycle (subset of the Shipment status enum, lowercase, monotonic).
const LIFECYCLE = ['booked', 'picked_up', 'in_transit', 'port_processing', 'customs_clearance', 'released', 'delivered'];

const mode = () => (process.env.TRACKING_API_KEY ? 'live' : 'simulated');

function locationFor(shipment, i, n) {
    if (i <= 0) return shipment.origin || 'Origin hub';
    if (i >= n - 1) return shipment.destination || 'Destination hub';
    return `In transit (${shipment.origin || '?'} → ${shipment.destination || '?'})`;
}

// Deterministic time-based tracker: progress = elapsed / (eta - created), clamped to [0,1].
function simulate(shipment) {
    const created = new Date(shipment.created_at || shipment.createdAt || Date.now()).getTime();
    const etaMs = shipment.estimated_arrival ? new Date(shipment.estimated_arrival).getTime() : created + 21 * 86400000;
    const totalMs = etaMs - created;
    const now = Date.now();
    const progress = totalMs <= 0 ? 1 : Math.max(0, Math.min(1, (now - created) / totalMs));

    const lastIdx = Math.min(LIFECYCLE.length - 1, Math.round(progress * (LIFECYCLE.length - 1)));
    const events = [];
    for (let i = 0; i <= lastIdx; i += 1) {
        const frac = LIFECYCLE.length > 1 ? i / (LIFECYCLE.length - 1) : 1;
        events.push({
            id: `TRK-${i}`,
            status: LIFECYCLE[i],
            location: locationFor(shipment, i, LIFECYCLE.length),
            timestamp: new Date(created + Math.max(totalMs, 0) * frac).toISOString(),
            source: 'simulated',
        });
    }
    return {
        mode: 'simulated',
        status: LIFECYCLE[lastIdx],
        progress: Math.round(progress * 100),
        eta: new Date(etaMs).toISOString(),
        position: events.length ? events[events.length - 1].location : (shipment.origin || 'Origin hub'),
        events,
    };
}

// Live integration placeholder — wire a real carrier API here when TRACKING_API_KEY is set.
async function liveTrack(shipment) {
    void shipment;
    throw new Error('live carrier tracking not configured');
}

// Returns the latest tracking view for a shipment, never throwing (falls back to simulate).
async function track(shipment) {
    if (mode() === 'live') {
        try { return await liveTrack(shipment); } catch { return simulate(shipment); }
    }
    return simulate(shipment);
}

const lifecycleIndex = (status) => {
    const i = LIFECYCLE.indexOf(String(status || '').toLowerCase());
    return i; // -1 for statuses outside the happy path (delayed/customs_hold/re_routed/cancelled)
};

function health() { return { name: 'tracking', mode: mode(), healthy: true }; }

module.exports = { track, simulate, health, mode, LIFECYCLE, lifecycleIndex };
