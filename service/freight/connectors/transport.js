'use strict';
/**
 * Shared HTTP transport for the real-carrier seam (Prompt 10).
 *
 * Every connector's `transmitQuote()` / `transmitBooking()` is "real when configured,
 * simulated otherwise": if the connector has an endpoint + credential from env, it
 * calls through here; otherwise it falls back to the deterministic simulator. This
 * module is the one place the actual wire call + timeout + transport-error
 * classification lives, so the four carrier connectors stay focused on their API's
 * message + response shape.
 *
 * Errors are funnelled through `connector.classifyTransport()` so a 5xx/timeout
 * becomes a TRANSIENT FreightError (retried + then fallback) and a 4xx becomes
 * PERMANENT (no retry, but still fall back to another carrier).
 */

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Send a JSON payload to a carrier endpoint and return the parsed JSON body.
 * @param {object} connector  the CarrierConnector (for classifyTransport)
 * @param {object} opts        { url, method, headers, payload, timeoutMs }
 * @throws {FreightError}       classified transient / permanent on failure
 */
async function httpSend(connector, { url, method = 'POST', headers = {}, payload, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
        res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
            body: method === 'GET' ? undefined : JSON.stringify(payload || {}),
            signal: controller.signal,
        });
    } catch (err) {
        throw connector.classifyTransport(err);
    } finally {
        clearTimeout(timer);
    }

    if (!res.ok) {
        let body = null;
        try { body = await res.text(); } catch { /* ignore */ }
        const fe = connector.classifyTransport(new Error(`carrier HTTP ${res.status}`), { status: res.status });
        fe.raw = { status: res.status, body };
        throw fe;
    }

    try {
        return await res.json();
    } catch {
        // 2xx but unparseable body — treat as transient (carrier hiccup).
        throw connector.failTransient('carrier returned an unparseable response body', { code: 'bad_json' });
    }
}

module.exports = { httpSend, DEFAULT_TIMEOUT_MS };
