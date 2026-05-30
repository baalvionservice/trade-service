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

// Generic persistence store — MUST be last so it only catches collections that
// have no bespoke typed route above (alerts, risk_signals, contracts, ...).
router.use('/:collection',   require('./collectionRoutes'));

module.exports = router;
