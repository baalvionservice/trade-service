'use strict';
/**
 * HTTP client to financial-services-java (the money system of record). The Node trade-service is the
 * orchestrator/BFF: it keeps a local projection row for fast UI reads, but the actual money movement is
 * executed by the Java payment-service. Events flow back via the HMAC finance-events webhook
 * (controller/internalController.js) which reconciles the projection.
 *
 * Design notes:
 *  - Short timeout + AbortController (no hanging on a down dependency).
 *  - Identity: forwards the inbound user bearer (gateway hybrid mode) + X-Tenant-ID. Java verifies RS256
 *    against auth-service when secured; trusts the header in dev (APP_SECURITY_ENABLED=false).
 *  - Errors carry .status + .data so the caller can map them to a precise HTTP response (no 500s).
 */
const config = require('../config/appConfig');

const TIMEOUT_MS = Number(process.env.FINANCE_HTTP_TIMEOUT_MS || 4000);

async function call(base, path, { method = 'GET', body, tenantId, idempotencyKey, bearer } = {}) {
    if (!base) { const e = new Error('finance base URL not configured'); e.status = 503; throw e; }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
        const headers = { 'Content-Type': 'application/json' };
        if (tenantId) headers['X-Tenant-ID'] = String(tenantId);
        if (idempotencyKey) headers['X-Idempotency-Key'] = String(idempotencyKey);
        if (bearer) headers.Authorization = `Bearer ${bearer}`;
        const res = await fetch(`${base}${path}`, {
            method,
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: ctrl.signal,
        });
        const text = await res.text();
        let data;
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
        if (!res.ok) {
            const e = new Error((data && data.message) || `finance upstream ${res.status}`);
            e.status = res.status;
            e.data = data;
            throw e;
        }
        return data;
    } catch (err) {
        if (err.name === 'AbortError') { const e = new Error('finance upstream timeout'); e.status = 504; throw e; }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

// Java payment-service: POST /api/v1/payments/initiate (InitiatePaymentRequest).
async function initiatePayment(payload, ctx = {}) {
    return call(config.finance.payment, '/api/v1/payments/initiate', {
        method: 'POST',
        body: {
            idempotencyKey: payload.idempotencyKey || ctx.idempotencyKey,
            sourceAccountId: payload.sourceAccountId || null,
            destinationAccountId: payload.destinationAccountId || null,
            amount: payload.amount,
            currency: payload.currency,
            paymentScheme: payload.paymentScheme || payload.scheme || 'INTERNAL',
            metadata: payload.metadata !== undefined
                ? (typeof payload.metadata === 'string' ? payload.metadata : JSON.stringify(payload.metadata))
                : null,
        },
        tenantId: ctx.tenantId,
        idempotencyKey: payload.idempotencyKey || ctx.idempotencyKey,
        bearer: ctx.bearer,
    });
}

// Extract the Java payment id / reference from an initiate response (tolerant of field naming).
function refFromInitiate(result) {
    if (!result || typeof result !== 'object') return null;
    return result.id || result.transactionRef || result.paymentId || result.payment_id || result.reference || null;
}

module.exports = { call, initiatePayment, refFromInitiate, enabled: () => config.finance.enabled };
