'use strict';
/**
 * Customs Gateway Abstraction Layer (War Room 4, Prompt 9) — public surface.
 *
 *   schema       vocabulary (STATUS / CHANNEL / FAILURE_KIND) + factories
 *   normalize    canonical declaration + response normalizers (PURE)
 *   connectors   the connector architecture — CustomsConnector base + the four
 *                government-gateway connectors + the pluggable registry
 *   gateway      DB-backed orchestrator (submit / process / retry / recover / status)
 *
 * The connector hierarchy the prompt asks for:
 *   CustomsConnector (base interface)
 *     ├── IndiaConnector  (ICEGATE placeholder)
 *     ├── USConnector     (ACE placeholder)
 *     ├── EUConnector     (EU CDS)
 *     └── UAEConnector    (Mirsal 2)
 *
 * Each connector owns the country-specific message + response mapping; the base
 * owns the async submission pipeline, the retry mechanism and failure
 * classification; the gateway owns persistence, durable retry, failure recovery
 * and response normalization across the lifecycle.
 */
module.exports = {
    schema: require('./schema'),
    normalize: require('./normalize'),
    connectors: require('./connectors'),
    gateway: require('./customsGateway'),
};
