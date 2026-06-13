'use strict';
/**
 * Carrier connector REGISTRY (Prompt 10).
 *
 * The single place a CARRIER (or a transport MODE) is resolved to a live connector
 * instance. Connectors are singletons (stateless aside from their env config), lazily
 * constructed on first use. The registry is PLUGGABLE: a new carrier integration can
 * be registered at runtime via `registerConnector()` without touching the quote
 * engine or the booking gateway — mirroring the customs connector registry's seam.
 *
 * `eligibleConnectors(request)` is the carrier-abstraction entry point the quote
 * comparison engine fans out across: it returns every connector that can serve the
 * shipment's mode (an ocean-only request never reaches an express-only carrier).
 */

const { CARRIER, carriersForMode, VALID_CARRIERS } = require('../schema');
const { CarrierConnector } = require('./baseConnector');
const { DhlConnector } = require('./dhlConnector');
const { FedexConnector } = require('./fedexConnector');
const { UpsConnector } = require('./upsConnector');
const { MaerskConnector } = require('./maerskConnector');

// carrier → factory (lazy: construct once, on demand).
const FACTORIES = {
    [CARRIER.DHL]: () => new DhlConnector(),
    [CARRIER.FEDEX]: () => new FedexConnector(),
    [CARRIER.UPS]: () => new UpsConnector(),
    [CARRIER.MAERSK]: () => new MaerskConnector(),
};

const instances = {};

/** Get (or lazily build) the connector for a carrier. */
function getConnectorByCarrier(carrier) {
    if (!carrier) return null;
    if (instances[carrier]) return instances[carrier];
    const factory = FACTORIES[carrier];
    if (!factory) return null;
    instances[carrier] = factory();
    return instances[carrier];
}

/**
 * Every connector eligible to serve a shipment request. Eligibility = the connector
 * serves the request's mode (null mode ⇒ every registered carrier is eligible and
 * will quote its own best mode). This is the fan-out set for the comparison engine.
 */
function eligibleConnectors(request = {}) {
    const carriers = carriersForMode(request.mode || null);
    return carriers
        .map((c) => getConnectorByCarrier(c))
        .filter((c) => c && (!request.mode || c.serves(request.mode)));
}

/**
 * Register (or override) a connector for a carrier. Accepts either a CarrierConnector
 * INSTANCE or a zero-arg factory. Enables a new carrier — or a mock in tests —
 * without editing this file.
 */
function registerConnector(carrier, connectorOrFactory) {
    if (typeof connectorOrFactory === 'function') {
        FACTORIES[carrier] = connectorOrFactory;
        delete instances[carrier];
        return;
    }
    if (connectorOrFactory instanceof CarrierConnector) {
        FACTORIES[carrier] = () => connectorOrFactory;
        instances[carrier] = connectorOrFactory;
        return;
    }
    throw new Error('registerConnector(): expected a CarrierConnector instance or a factory function');
}

/** Reset registry overrides back to the built-in connectors (test hygiene). */
function resetConnectors() {
    Object.keys(instances).forEach((k) => delete instances[k]);
    FACTORIES[CARRIER.DHL] = () => new DhlConnector();
    FACTORIES[CARRIER.FEDEX] = () => new FedexConnector();
    FACTORIES[CARRIER.UPS] = () => new UpsConnector();
    FACTORIES[CARRIER.MAERSK] = () => new MaerskConnector();
}

/** The carriers the registry can currently serve. */
function supportedCarriers() {
    return VALID_CARRIERS.filter((c) => typeof FACTORIES[c] === 'function');
}

module.exports = {
    getConnectorByCarrier,
    eligibleConnectors,
    registerConnector,
    resetConnectors,
    supportedCarriers,
    // re-export the connector classes for direct use / testing
    CarrierConnector,
    DhlConnector,
    FedexConnector,
    UpsConnector,
    MaerskConnector,
};
