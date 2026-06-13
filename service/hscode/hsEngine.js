'use strict';
/**
 * HS Code Intelligence Engine — DB-backed ORCHESTRATOR (Prompt 7).
 *
 * Wraps the PURE layers (search, aiSuggester, fallbackRules, compliance, duty,
 * report) with the persistence + context-loading they deliberately avoid:
 *
 *   • suggest()         — stateless. Run the full product → HS pipeline (search +
 *                         AI + fallback fusion → compliance flags → duty hook) and
 *                         return an hs_suggestion_report. No DB. Async only because
 *                         the AI provider may be remote.
 *
 *   • classifyProduct() — load the parent trade operation for context (origin /
 *                         destination / declared value fill the gaps in the
 *                         request), run suggest(), and persist the result as an
 *                         HsClassification row (append-only audit).
 *
 *   • lookup()          — resolve a specific HS code: its description, the per-
 *                         country national line, compliance flags and duty hook.
 *
 *   • search()          — thin passthrough to the pure search layer (the search API).
 *
 * The pipeline ALWAYS returns something actionable: search + AI first, and the
 * deterministic fallback rules engine fills in coarse chapter-level candidates
 * for any product the first two can't confidently place.
 */

const dbModels = require('../../models');
const search = require('./search');
const aiSuggester = require('./aiSuggester');
const fallbackRules = require('./fallbackRules');
const compliance = require('./compliance');
const duty = require('./duty');
const report = require('./report');
const hsDatabase = require('./hsDatabase');
const norm = require('./normalize');
const { METHOD, suggestion } = require('./schema');
const { AppError } = require('../../utils/errors');

const DEFAULT_LIMIT = 5;
const LOW_CONFIDENCE_FOR_FALLBACK = 50; // trigger fallback when best < this

/** Direction inferred from origin/destination relative to nothing — default both. */
function inferDirection(/* originCountry, destinationCountry */) {
    // Without a "home" country the engine can't know import vs export; screen both.
    return 'both';
}

/**
 * Stateless product → HS suggestion pipeline.
 *
 * @param {object} input
 * @param {string} input.product
 * @param {string} [input.hsCode]              optional asserted code → EXACT candidate
 * @param {string} [input.destinationCountry]
 * @param {string} [input.originCountry]
 * @param {number} [input.customsValue]
 * @param {string} [input.currency]
 * @param {number} [input.limit=5]
 * @param {object} [input.options]             { minScore, includeFallback }
 * @param {Date}   [input.now]
 * @returns {Promise<object>} hs_suggestion_report
 */
async function suggest({
    product = '', hsCode = null, destinationCountry = null, originCountry = null,
    customsValue = null, currency = null, limit = DEFAULT_LIMIT, options = {}, now = new Date(),
} = {}) {
    const country = norm.normalizeCountry(destinationCountry);
    const candidates = [];

    // 0. Exact: caller asserted a code that resolves to a known entry.
    if (hsCode && norm.isHsCodeLike(hsCode)) {
        const entry = hsDatabase.findByCode(hsCode);
        if (entry) {
            const line = country ? hsDatabase.tariffLine(entry, country) : null;
            candidates.push(suggestion({
                hs_code: entry.hs_code, description: entry.description, chapter: entry.chapter,
                heading: entry.heading, category: entry.category, method: METHOD.EXACT,
                confidence: 100, matched_on: [`asserted_code:${norm.digitsOnly(hsCode)}`],
                national_code: line ? line.national : null, country: line ? country : null,
                source: 'database',
            }));
        }
    }

    // 1. Keyword search + 2. AI suggestion (independent producers).
    if (product && String(product).trim()) {
        const [searchHits, aiResult] = await Promise.all([
            Promise.resolve(search.search({ query: product, country, limit, minScore: options.minScore })),
            aiSuggester.suggest({ product, country, limit }),
        ]);
        candidates.push(...searchHits, ...aiResult.suggestions);
    }

    // 3. Fallback rules engine — only when nothing confident surfaced.
    const bestSoFar = candidates.reduce((m, c) => Math.max(m, c.confidence), 0);
    const includeFallback = options.includeFallback !== false;
    if (includeFallback && product && bestSoFar < LOW_CONFIDENCE_FOR_FALLBACK) {
        candidates.push(...fallbackRules.run({ product, country, limit: 3 }));
    }

    // Fuse for the winning code, then attach compliance + duty for it.
    const fused = report.fuse(candidates);
    const best = fused[0] || null;

    let complianceFlags = [];
    let dutyEstimate = null;
    let blocking = false;
    if (best) {
        const direction = inferDirection(originCountry, destinationCountry);
        complianceFlags = compliance.evaluate({ hsCode: best.hs_code, country, direction });
        blocking = compliance.isBlocking(complianceFlags);
        dutyEstimate = duty.estimateDuty({
            hsCode: best.hs_code, country, originCountry, customsValue, currency,
        });
    }

    return report.build({
        query: { product, destinationCountry, originCountry, customsValue, currency },
        candidates, complianceFlags, dutyEstimate, blocking, limit, now,
    });
}

/**
 * Classify a product in the context of a trade operation and persist the report.
 *
 * @param {object} input
 * @param {string} [input.tradeOperationId]   fills gaps in country/value/currency
 * @param {string} [input.productRef]         caller's product id/sku (for the row)
 * @param {string} input.product
 * @param {string} [input.hsCode]
 * @param {string} [input.destinationCountry]
 * @param {string} [input.originCountry]
 * @param {number} [input.customsValue]
 * @param {string} [input.currency]
 * @param {number} [input.limit]
 * @param {object} [input.options]
 * @param {string} [input.actor]
 * @param {boolean} [input.persist=true]
 * @param {Date}   [input.now]
 * @returns {Promise<{ report: object, record: object|null }>}
 */
async function classifyProduct({
    tradeOperationId = null, productRef = null, product = '', hsCode = null,
    destinationCountry = null, originCountry = null, customsValue = null, currency = null,
    limit = DEFAULT_LIMIT, options = {}, actor = null, persist = true, now = new Date(),
} = {}) {
    let operation = null;
    if (tradeOperationId) {
        operation = await dbModels.TradeOperation.findByPk(tradeOperationId);
        if (!operation) throw new AppError('NOT_FOUND', 'Trade operation not found', 404);
    }

    // Operation context fills the gaps the caller didn't provide.
    const resolved = {
        product: product || (operation && operation.commodity) || '',
        hsCode: hsCode || (operation && operation.hs_code) || null,
        destinationCountry: destinationCountry || (operation && operation.destination_country) || null,
        originCountry: originCountry || (operation && operation.origin_country) || null,
        customsValue: customsValue != null ? customsValue : (operation && operation.total_value) || null,
        currency: currency || (operation && operation.currency) || null,
    };

    const suggestionReport = await suggest({ ...resolved, limit, options, now });

    let record = null;
    if (persist) {
        record = await persistClassification({
            operation, productRef, report: suggestionReport, actor,
        });
    }
    return { report: suggestionReport, record };
}

/** Persist an hs_suggestion_report as an HsClassification row (if the model exists). */
async function persistClassification({ operation, productRef, report: r, actor }) {
    if (!dbModels.HsClassification) return null; // migration not applied — degrade
    const best = r.best;
    const payload = {
        document_ref: productRef ? String(productRef) : null,
        product_description: r.query.product,
        trade_operation_id: operation ? operation.id : null,
        destination_country: r.query.destination_country,
        origin_country: r.query.origin_country,
        suggested_code: best ? best.hs_code : null,
        national_code: best ? best.national_code : null,
        method: best ? best.method : null,
        confidence: best ? best.confidence : 0,
        confidence_band: r.summary.best_band,
        needs_review: r.summary.needs_review,
        blocking: r.summary.blocking,
        flag_count: r.compliance_flags.length,
        duty_estimate: r.duty_estimate || {},
        report: r,
        created_by: actor,
    };
    if (operation && operation.tenant_id) payload.tenant_id = operation.tenant_id;
    return dbModels.HsClassification.create(payload);
}

/**
 * Resolve a specific HS code with its national line, compliance flags + duty.
 *
 * @param {object} input
 * @param {string} input.hsCode
 * @param {string} [input.country]
 * @param {number} [input.customsValue]
 * @param {string} [input.currency]
 * @param {('import'|'export'|'both')} [input.direction='both']
 * @returns {object}
 */
function lookup({ hsCode, country = null, customsValue = null, currency = null, direction = 'both' } = {}) {
    const entry = hsDatabase.findByCode(hsCode);
    if (!entry) throw new AppError('NOT_FOUND', `HS code '${hsCode}' not found in reference database`, 404);
    const iso = norm.normalizeCountry(country);
    const line = iso ? hsDatabase.tariffLine(entry, iso) : null;
    const complianceFlags = compliance.evaluate({ hsCode: entry.hs_code, country: iso, direction });

    return {
        hs_code: entry.hs_code,
        description: entry.description,
        chapter: entry.chapter,
        heading: entry.heading,
        category: entry.category,
        unit: entry.unit,
        country: iso,
        national_code: line ? line.national : null,
        tariff: line ? { duty_rate: line.duty, vat_rate: line.vat, national_code: line.national } : null,
        available_countries: Object.keys(entry.tariffs),
        compliance_flags: complianceFlags,
        blocking: compliance.isBlocking(complianceFlags),
        duty_estimate: iso ? duty.estimateDuty({ hsCode: entry.hs_code, country: iso, customsValue, currency }) : null,
    };
}

/** Thin passthrough to the pure search layer (the search API). */
function searchCodes(input) {
    return search.search(input);
}

module.exports = {
    suggest,
    classifyProduct,
    lookup,
    search: searchCodes,
    DEFAULT_LIMIT,
};
