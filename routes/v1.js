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

// Logistics — Digital Bill of Lading: typed e-B/L with title-transfer/surrender lifecycle.
router.use('/bills_of_lading', require('./billOfLadingRoutes'));

// Logistics — Customs Filing: typed customs entries + HS classifier + tariff + country templates.
router.use('/customs_entries', require('./customsRoutes'));

// Generic persistence store — MUST be last so it only catches collections that
// have no bespoke typed route above (alerts, risk_signals, contracts, ...).
router.use('/:collection',   require('./collectionRoutes'));

module.exports = router;
