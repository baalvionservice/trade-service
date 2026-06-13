'use strict';
/**
 * Freight Marketplace Integration Layer (War Room 4, Prompt 10) — public surface.
 *
 *   schema       vocabulary (STATUS / CARRIER / MODE / FAILURE_KIND) + factories
 *   normalize    canonical shipment-request + chargeable-weight normalizers (PURE)
 *   eta          door-to-door ETA calculation engine (PURE)
 *   connectors   the carrier abstraction — CarrierConnector base + the four carrier
 *                integrations (DHL / FedEx / UPS / Maersk) + the pluggable registry
 *   quoteEngine  the quote COMPARISON engine — fan-out across eligible carriers + rank
 *   gateway      DB-backed orchestrator — booking workflow + carrier FALLBACK + recovery
 *
 * The connector hierarchy the prompt asks for:
 *   CarrierConnector (base interface)
 *     ├── DhlConnector     (DHL Express / Global Forwarding placeholder)
 *     ├── FedexConnector   (FedEx Express / Freight placeholder)
 *     ├── UpsConnector     (UPS Rating / Shipping placeholder)
 *     └── MaerskConnector  (Maersk Line ocean placeholder)
 *
 * Each connector owns its carrier-specific rate/booking message + response mapping;
 * the base owns the async quote + booking pipelines, the in-process retry, and
 * failure classification; the comparison engine ranks across carriers; the gateway
 * owns persistence, the booking lifecycle, the carrier-to-carrier fallback and
 * recovery.
 */
module.exports = {
    schema: require('./schema'),
    normalize: require('./normalize'),
    eta: require('./eta'),
    connectors: require('./connectors'),
    quoteEngine: require('./quoteEngine'),
    gateway: require('./freightGateway'),
};
