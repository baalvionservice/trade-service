'use strict';
/**
 * Internal service-to-service ingress — NOT a user-facing API.
 *
 * `POST /v1/internal/finance-events` is the Java→Node event bridge: financial-services-java
 * (audit-service WebhookDispatcher) delivers money/risk events here over HMAC-SHA256, and we
 * project them onto trade-service's read models (Payment/Order/Escrow) + fan out over realtime
 * so the GTI frontend's finance pages update live. Java uses BullMQ-less Kafka internally; this
 * webhook is the deliberate seam so the Node stack needs no Kafka client.
 *
 * Auth: NOT a user JWT — authenticated by the shared HMAC secret (config.finance.webhookSecret,
 * must equal the audit-service webhook_subscription secret). Verified over the EXACT raw bytes.
 */
const crypto = require('crypto');
const config = require('../config/appConfig');
const db = require('../models');
const { runAs } = require('../middleware/tenantContext');
const realtime = require('../realtime');

// Bounded in-memory idempotency cache keyed by X-Webhook-Id. A dev bridge: projection updates are
// themselves idempotent (setting a terminal status on replay is a no-op), so a crash that loses
// this cache is safe — it just lets one duplicate event re-apply harmlessly.
const seen = new Map();
const SEEN_MAX = 5000;
function alreadyProcessed(id) {
    if (!id) return false;
    if (seen.has(id)) return true;
    seen.set(id, Date.now());
    if (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value);
    return false;
}

// Matches financial-services-java WebhookSigner: "sha256=" + lowercase-hex HMAC-SHA256(secret, payload).
function verifySignature(req) {
    const header = req.headers['x-webhook-signature'] || '';
    const secret = config.finance.webhookSecret;
    if (!secret || !header.startsWith('sha256=')) return false;
    // CR-9: verify over the EXACT raw bytes only. A JSON re-stringify fallback
    // would let a caller bypass the signature by exploiting key-order / encoding
    // differences, so a missing rawBody is a hard verification failure.
    if (!req.rawBody || !Buffer.isBuffer(req.rawBody)) return false;
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Java payment event type → trade-service Payment.status.
const PAYMENT_STATUS = {
    'payments.transaction.initiated': 'processing',
    'payments.transaction.completed': 'completed',
    'payments.transaction.failed': 'failed',
    'payments.transaction.reversed': 'refunded',
};

// The reference linking a Java payment to the trade-service Payment row (stored in provider_tx_id
// when the facade initiates the payment). Tolerant of the various names the event may carry.
function refOf(p) {
    return p.transactionRef || p.provider_tx_id || p.providerTxId || p.paymentId
        || p.payment_id || p.reference || p.id || null;
}

async function applyPaymentProjection(eventType, payload) {
    const status = PAYMENT_STATUS[eventType];
    const ref = refOf(payload);
    if (!status || !ref) return { matched: false, ref: ref || null };
    // bypass tenant scoping — this is a trusted system write, not a user request.
    return runAs({ bypass: true }, async () => {
        const payment = await db.Payment.findOne({ where: { provider_tx_id: String(ref) } });
        if (!payment) return { matched: false, ref };
        payment.status = status;
        if (status === 'completed' && !payment.settled_at) payment.settled_at = new Date();
        payment.metadata = { ...(payment.metadata || {}), lastFinanceEvent: eventType, financeUpdatedAt: new Date().toISOString() };
        await payment.save();
        return { matched: true, ref, paymentId: payment.id, status };
    });
}

// Best-effort durable trail so the event is inspectable in the UI (collection: finance_events).
async function recordEvent(eventType, tenantId, payload) {
    try {
        await runAs({ bypass: true }, () => db.Collection.create({
            collection: 'finance_events',
            tenantId: tenantId || 'T-DEMO',
            data: { eventType, receivedAt: new Date().toISOString(), payload },
        }));
    } catch (err) { console.error('[finance-events] trail write failed:', err.message); }
}

exports.financeEvents = async (req, res) => {
    if (!verifySignature(req)) {
        return res.status(401).json({ error: { code: 'BAD_SIGNATURE', message: 'invalid webhook signature' } });
    }
    const eventType = req.headers['x-webhook-event'] || (req.body && req.body.eventType) || 'unknown';
    const webhookId = req.headers['x-webhook-id'] || null;
    if (alreadyProcessed(webhookId)) return res.status(200).json({ ok: true, deduped: true, event: eventType });

    const payload = (req.body && typeof req.body === 'object') ? req.body : {};
    const tenantId = payload.tenantId || payload.tenant_id || null;

    let projection = { matched: false };
    try {
        if (eventType.startsWith('payments.')) projection = await applyPaymentProjection(eventType, payload);
        // escrow.* / settlement.* / risk.* projections land in their own phases; until then the
        // event is still recorded + broadcast so the UI sees it live (no data loss).
    } catch (err) {
        // Mapping gaps are not transient — record + 200 so Java does not retry forever.
        console.error('[finance-events] projection error:', eventType, err.message);
    }

    await recordEvent(eventType, tenantId, payload);
    try { if (tenantId) await realtime.publish(`tenant:${tenantId}`, eventType, { ...payload, _projection: projection }); }
    catch (err) { console.error('[finance-events] realtime publish failed:', err.message); }

    return res.status(200).json({ ok: true, event: eventType, projection });
};
