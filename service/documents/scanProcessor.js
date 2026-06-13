'use strict';
/**
 * Virus-scan job processor (War Room 4, Prompt 4). Runs in the BullMQ worker, i.e.
 * OUTSIDE any HTTP request, so it has no tenant AsyncLocalStorage scope. It therefore
 * runs under an explicit `runAs({ bypass: true })` context: the document/version rows
 * belong to a tenant the worker isn't "logged in" as, and bypass lets the RLS GUC
 * bridge + Sequelize tenant hooks read/write them. The job payload is non-secret
 * (ids only); the bytes are fetched from storage and decrypted in-process.
 *
 * Flow: load version → fetch+decrypt bytes → scan → apply verdict (release or
 * quarantine the document) → record audit. Throws on transient failure so BullMQ
 * retries; an exhausted job is dead-lettered (replayable) by the worker harness.
 */
const { runAs } = require('../../middleware/tenantContext');
const db = require('../../models');
const engine = require('./documentEngine');
const virusScan = require('../../lib/virusScan');
const { recordAudit } = require('../../utils/audit');
const logger = require('../logger');

async function processScan(job) {
    const { versionId } = job.data || {};
    if (!versionId) return { skipped: true, reason: 'no versionId' };

    return runAs({ bypass: true }, async () => {
        const version = await db.DocumentVersion.findByPk(versionId);
        if (!version) {
            logger.warn('Scan job for unknown version', { versionId });
            return { skipped: true, reason: 'version_not_found' };
        }
        // Idempotency: a re-delivered job for an already-scanned version is a no-op.
        if (version.scan_status !== 'pending') {
            return { skipped: true, reason: `already_${version.scan_status}` };
        }

        const bytes = await engine.fetchPlaintext(version);
        const verdict = await virusScan.scan(bytes, { fileName: version.file_name });
        const passing = virusScan.isPassing(verdict.status);

        await engine.applyScanResult({
            versionId: version.id,
            status: verdict.status,
            engine: verdict.engine,
            signature: verdict.signature,
            raw: { status: verdict.status, engine: verdict.engine, signature: verdict.signature, note: verdict.raw },
            isPassing: passing,
        });

        await recordAudit({
            actorId: 'document-scanner',
            action: passing ? 'document.scan.passed' : 'document.scan.quarantined',
            resourceType: 'document_version',
            resourceId: version.id,
            tenantId: version.tenant_id,
            metadata: { documentId: version.document_id, status: verdict.status, engine: verdict.engine, signature: verdict.signature },
        });

        logger.info('Document scan completed', { versionId: version.id, status: verdict.status, engine: verdict.engine, released: passing });
        return { versionId: version.id, status: verdict.status, released: passing };
    });
}

module.exports = { processScan };
