'use strict';
/**
 * Shared HTTP transport for the real-gateway seam (Prompt 9).
 *
 * Every connector's `transmit()` is "real when configured, simulated otherwise":
 * if the connector has an endpoint + credential from env, it POSTs through here;
 * otherwise it falls back to the deterministic simulator. This module is the one
 * place the actual wire call + timeout + transport-error classification lives, so
 * the four connectors stay focused on their gateway's message + response shape.
 *
 * Errors are funnelled through `connector.classifyTransport()` so a 5xx/timeout
 * becomes a TRANSIENT GatewayError (retried) and a 4xx becomes PERMANENT.
 */

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * POST a JSON payload to a gateway endpoint and return the parsed JSON body.
 * @param {object} connector  the CustomsConnector (for classifyTransport)
 * @param {object} opts        { url, headers, payload, timeoutMs }
 * @throws {GatewayError}       classified transient / permanent on failure
 */
async function httpTransmit(connector, { url, headers = {}, payload, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(payload || {}),
            signal: controller.signal,
        });
    } catch (err) {
        throw connector.classifyTransport(err);
    } finally {
        clearTimeout(timer);
    }

    if (!res.ok) {
        // Surface the body for the audit, then classify by status code.
        let body = null;
        try { body = await res.text(); } catch { /* ignore */ }
        const ge = connector.classifyTransport(new Error(`gateway HTTP ${res.status}`), { status: res.status });
        ge.raw = { status: res.status, body };
        throw ge;
    }

    try {
        return await res.json();
    } catch (err) {
        // 2xx but unparseable body — treat as transient (gateway hiccup).
        throw connector.failTransient('gateway returned an unparseable response body', { code: 'bad_json' });
    }
}

module.exports = { httpTransmit, DEFAULT_TIMEOUT_MS };
