'use strict';
/**
 * Connector REGISTRY (Prompt 9).
 *
 * The single place a CHANNEL or a destination COUNTRY is resolved to a live
 * connector instance. Connectors are singletons (stateless aside from their env
 * config), lazily constructed on first use. The registry is PLUGGABLE: a new
 * jurisdiction's connector can be registered at runtime via `registerConnector()`
 * without touching the gateway — mirroring the HS engine's pluggable AI provider
 * and the compliance engine's provider seam.
 */

const { CHANNEL, channelForCountry, VALID_CHANNELS } = require('../schema');
const { CustomsConnector } = require('./baseConnector');
const { IndiaConnector } = require('./indiaConnector');
const { USConnector } = require('./usConnector');
const { EUConnector } = require('./euConnector');
const { UAEConnector } = require('./uaeConnector');

// channel → factory (lazy: construct once, on demand).
const FACTORIES = {
    [CHANNEL.ICEGATE]: () => new IndiaConnector(),
    [CHANNEL.ACE]: () => new USConnector(),
    [CHANNEL.EU_CDS]: () => new EUConnector(),
    [CHANNEL.UAE_MIRSAL]: () => new UAEConnector(),
};

const instances = {};

/** Get (or lazily build) the connector for a channel. */
function getConnectorByChannel(channel) {
    if (!channel) return null;
    if (instances[channel]) return instances[channel];
    const factory = FACTORIES[channel];
    if (!factory) return null;
    instances[channel] = factory();
    return instances[channel];
}

/** Resolve the connector for an ISO-2 destination/jurisdiction country. */
function getConnectorForCountry(iso2) {
    return getConnectorByChannel(channelForCountry(iso2));
}

/**
 * Register (or override) a connector for a channel. Accepts either a
 * CustomsConnector INSTANCE or a zero-arg factory. Enables a new jurisdiction —
 * or a mock in tests — without editing this file.
 */
function registerConnector(channel, connectorOrFactory) {
    if (typeof connectorOrFactory === 'function') {
        FACTORIES[channel] = connectorOrFactory;
        delete instances[channel]; // force rebuild on next get
        return;
    }
    if (connectorOrFactory instanceof CustomsConnector) {
        FACTORIES[channel] = () => connectorOrFactory;
        instances[channel] = connectorOrFactory;
        return;
    }
    throw new Error('registerConnector(): expected a CustomsConnector instance or a factory function');
}

/** Reset registry overrides back to the built-in connectors (test hygiene). */
function resetConnectors() {
    Object.keys(instances).forEach((k) => delete instances[k]);
    FACTORIES[CHANNEL.ICEGATE] = () => new IndiaConnector();
    FACTORIES[CHANNEL.ACE] = () => new USConnector();
    FACTORIES[CHANNEL.EU_CDS] = () => new EUConnector();
    FACTORIES[CHANNEL.UAE_MIRSAL] = () => new UAEConnector();
}

/** The channels the registry can currently serve. */
function supportedChannels() {
    return VALID_CHANNELS.filter((c) => typeof FACTORIES[c] === 'function');
}

module.exports = {
    getConnectorByChannel,
    getConnectorForCountry,
    registerConnector,
    resetConnectors,
    supportedChannels,
    // re-export the connector classes for direct use / testing
    CustomsConnector,
    IndiaConnector,
    USConnector,
    EUConnector,
    UAEConnector,
};
