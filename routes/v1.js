'use strict';
const router = require('express').Router();

router.use('/auth',          require('./authRoutes'));
router.use('/organizations', require('./organizationRoutes'));
router.use('/companies',     require('./organizationRoutes'));
router.use('/marketplace_listings', require('./listingRoutes'));
router.use('/rfqs',          require('./rfqRoutes'));
router.use('/quotations',    require('./quotationRoutes'));
router.use('/chat_messages', require('./messageRoutes'));
router.use('/deals',         require('./dealRoutes'));
router.use('/orders',        require('./orderRoutes'));
router.use('/escrows',       require('./escrowRoutes'));
router.use('/shipments',     require('./shipmentRoutes'));
router.use('/documents',     require('./documentRoutes'));
router.use('/payments',      require('./paymentRoutes'));
router.use('/compliance',    require('./complianceRoutes'));
router.use('/disputes',      require('./disputeRoutes'));
router.use('/wallets',       require('./walletRoutes'));
router.use('/notifications', require('./notificationRoutes'));
router.use('/admin',         require('./adminRoutes'));

// Bespoke aggregation + provider endpoints (single objects, not collection arrays).
router.get('/platform_stats', require('../controller/statsController').platformStats);
router.use('/fx', require('./fxRoutes'));
router.get('/providers/health', require('../controller/providersController').health);
router.use('/audit', require('./auditRoutes'));
router.use('/queues', require('./queueRoutes'));

// Live system telemetry (infra topology / pulse / readiness) — real measured stack state.
const systemController = require('../controller/systemController');
router.get('/system/services',  systemController.services);
router.get('/system/pulse',     systemController.pulse);
router.get('/system/readiness', systemController.readiness);

// Internal service-to-service ingress (HMAC-authenticated). Java→Node finance event bridge.
router.use('/internal', require('./internalRoutes'));

// Logistics — Freight Booking: carrier marketplace + quote engine + selection (typed; shadow the store).
const freightController = require('../controller/freightController');
router.use('/carriers', require('./carrierRoutes'));
router.get('/shipping_quotes',      freightController.getQuotes);
router.post('/shipping_selections', freightController.selectCarrier);

// Logistics — Freight Marketplace Integration Layer (War Room 4, Prompt 10):
// carrier abstraction (DHL/FedEx/UPS/Maersk connectors) + quote COMPARISON engine +
// ETA calculation + the booking workflow with carrier-to-carrier FALLBACK logic.
router.use('/freight', require('./freightMarketplaceRoutes'));

// Logistics — Digital Bill of Lading: typed e-B/L with title-transfer/surrender lifecycle.
router.use('/bills_of_lading', require('./billOfLadingRoutes'));

// Logistics — Customs Filing: typed customs entries + HS classifier + tariff + country templates.
router.use('/customs_entries', require('./customsRoutes'));

// Logistics — Certificate of Origin: typed CoO with issue → chamber-certify lifecycle + e-stamp.
router.use('/certificates_of_origin', require('./certificateOfOriginRoutes'));

// Logistics — Carbon Footprint (P2): CO2e estimate per shipment + offset + ESG report.
router.use('/carbon_footprints', require('./carbonRoutes'));

// Insurance — cargo/credit/parametric policies (quote→bind) + claims (file→pay) lifecycle.
router.use('/insurance_policies', require('./insuranceRoutes'));
router.use('/insurance_claims', require('./insuranceClaimsRoutes'));

// Trade Operations — Shipment Workflow State Machine (War Room 4, Prompt 2):
// deterministic event-driven lifecycle engine + transition event log + webhooks.
router.use('/shipment_workflows', require('./workflowRoutes'));

// Trade Operations — Document Management System / production file engine (War Room 4,
// Prompt 4): secure upload → S3-compatible storage → versioning → virus scan →
// envelope encryption → metadata extraction → shipment linkage + chain of custody.
router.use('/trade_documents', require('./tradeDocumentRoutes'));

// Trade Operations — AI Document Validation Engine (Prompt 5): rules engine +
// pluggable AI classification layer checking trade documents for quantity/weight/
// address/currency/tax mismatches and missing fields, emitting a validation_report
// + readiness-impact score.
router.use('/document_validations', require('./validationRoutes'));

// Trade Operations — shared operations Dashboard APIs (War Room 4, Prompt 3):
// filtered/paginated shipments, merged timeline, readiness score, documents,
// comments — RBAC (buyer/seller/admin/logistics/bank) + tenant isolation +
// caching + per-caller rate limiting.
router.use('/dashboard', require('./dashboardRoutes'));

// Trade Operations — Shipment Readiness Score Engine (Prompt 6): weighted 0–100
// readiness from compliance/documentation/logistics/risk component scores, with
// DB-persisted snapshot history, a Redis cache layer and event-triggered
// recalculation (workflow transition / document validation / shipment status).
router.use('/shipment_readiness', require('./readinessRoutes'));

// Trade Operations — HS Code Intelligence Engine (Prompt 7): product → HS code
// classification (keyword search + pluggable AI suggester + deterministic
// fallback rules engine), multi-country tariff mapping, confidence scoring,
// compliance flags and duty-estimation hooks.
router.use('/hs_codes', require('./hsCodeRoutes'));

// Trade Operations — Compliance & Sanctions Engine (Prompt 8): rules engine over
// sanctioned countries/parties, restricted + dual-use + prohibited goods and
// country-specific export/import bans, with a tenant blacklist/whitelist, KYC/AML
// hooks and violation severity scoring → clear/review/block decision + persisted
// screening audit. Distinct from the legacy /v1/compliance ComplianceCase CRUD.
router.use('/compliance_screening', require('./complianceEngineRoutes'));

// Trade Operations — Customs Gateway Abstraction Layer (Prompt 9): connector
// architecture (CustomsConnector base → ICEGATE/ACE/EU-CDS/Mirsal) with an async
// submission pipeline, in-process + durable-queue retry, failure recovery and
// cross-gateway response normalization. Distinct from the legacy typed
// /v1/customs_entries declaration CRUD.
router.use('/customs_submissions', require('./customsGatewayRoutes'));

// Trade Operations — Dispatch Orchestration Engine (Prompt 11): automation engine
// that fires a shipment's dispatch the moment its four gates clear (documents
// validated, compliance passed, customs ready, freight booked) via a rule engine,
// workflow-driven event triggers, a webhook system and a saga-based failure-rollback
// system. Plans auto-advance from gate signals emitted by the shipment workflow.
router.use('/dispatch_orchestrations', require('./dispatchRoutes'));

// Trade Operations — Compliance AI Agent (Prompt 13): an AI agent that scans a
// shipment, detects risks, flags compliance issues and EXPLAINS its reasoning via
// a rule + AI hybrid over the Prompt 8 sanctions engine — with first-class
// confidence scoring and explainability output. Distinct from the deterministic
// /v1/compliance_screening rule engine it builds on.
router.use('/compliance_agent', require('./complianceAgentRoutes'));

// Trade Operations — Logistics Optimization Agent (Prompt 14): carrier selection +
// multi-leg route optimization over a lane network + cost-vs-speed scoring. Returns
// the cheapest / fastest / balanced route for a shipment, persists the run, and lets
// the caller commit a route (handing off to the Prompt 10 freight marketplace to
// book its first leg). Network descriptor is public at /network.
router.use('/route_optimizations', require('./logisticsRoutes'));

// Generic persistence store — MUST be last so it only catches collections that
// have no bespoke typed route above (alerts, risk_signals, contracts, ...).
router.use('/:collection',   require('./collectionRoutes'));

module.exports = router;
