'use strict';
/**
 * Standalone Node smoke test for the Document Management file engine (War Room 4,
 * Prompt 4). The repo's jest is currently broken (jest-runtime@30 vs jest@29 →
 * `clearMocksOnScope` on every resetModules), so this script asserts the same
 * behaviours the jest suite (document-engine.test.js) describes, runnable with:
 *   node tests/document-engine.smoke.js
 * Exits non-zero on the first failed assertion.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-engine-'));
process.env.DOC_STORAGE_LOCAL_DIR = TMP;
process.env.DOC_STORAGE_PROVIDER = 'local';
process.env.DOC_MAX_UPLOAD_BYTES = String(1024 * 1024);
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'dev_test_access_secret_min_32_chars_long_xx';

let passed = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { passed += 1; console.log('  ✓', name); }, (e) => { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; });

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('1 0 obj<</Type /Page >>endobj\n'), Buffer.from('%%EOF')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), (() => { const b = Buffer.alloc(8); b.writeUInt32BE(640, 0); b.writeUInt32BE(480, 4); return b; })()]);

(async () => {
    const validation = require('../lib/documentValidation');
    const metadata = require('../lib/metadataExtraction');
    const virusScan = require('../lib/virusScan');

    console.log('documentValidation');
    await ok('detects PDF', () => assert.strictEqual(validation.sniffMimeType(PDF), 'application/pdf'));
    await ok('detects PNG', () => assert.strictEqual(validation.sniffMimeType(PNG), 'image/png'));
    await ok('null on unknown', () => assert.strictEqual(validation.sniffMimeType(Buffer.from('nope')), null));
    await ok('accepts valid PDF', () => assert.strictEqual(validation.validateUpload({ buffer: PDF, fileName: 'invoice.pdf', declaredMime: 'application/pdf', docType: 'commercial_invoice' }).ok, true));
    await ok('rejects content-type spoof', () => assert.strictEqual(validation.validateUpload({ buffer: PNG, fileName: 'fake.pdf', declaredMime: 'application/pdf' }).ok, false));
    await ok('rejects empty', () => assert.strictEqual(validation.validateUpload({ buffer: Buffer.alloc(0), fileName: 'x.pdf' }).ok, false));
    await ok('rejects oversized', () => assert.strictEqual(validation.validateUpload({ buffer: Buffer.concat([PDF, Buffer.alloc(2 * 1024 * 1024)]), fileName: 'big.pdf', declaredMime: 'application/pdf' }).ok, false));
    await ok('rejects disallowed mime', () => assert.strictEqual(validation.validateUpload({ buffer: PDF, fileName: 'x.exe', declaredMime: 'application/x-msdownload' }).ok, false));
    await ok('rejects bad doc_type', () => assert.strictEqual(validation.validateUpload({ buffer: PDF, fileName: 'x.pdf', declaredMime: 'application/pdf', docType: 'nonsense' }).ok, false));
    await ok('sanitizes traversal', () => assert.strictEqual(validation.sanitizeFileName('../../etc/passwd'), 'passwd'));
    await ok('sanitize never empty', () => assert.strictEqual(validation.sanitizeFileName('...'), 'document'));

    console.log('metadataExtraction');
    await ok('sha256 stable + 64 hex', () => { const a = metadata.sha256(PDF); assert.strictEqual(a, metadata.sha256(PDF)); assert.strictEqual(a.length, 64); });
    await ok('PDF version + pages', () => { const m = metadata.extract({ buffer: PDF, detectedMime: 'application/pdf', fileName: 'i.pdf' }); assert.strictEqual(m.pdfVersion, '1.7'); assert.strictEqual(m.pageCount, 1); });
    await ok('PNG dimensions', () => { const m = metadata.extract({ buffer: PNG, detectedMime: 'image/png', fileName: 's.png' }); assert.strictEqual(m.width, 640); assert.strictEqual(m.height, 480); });

    console.log('encryption (with key)');
    process.env.DOCUMENT_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
    delete require.cache[require.resolve('../config/appConfig')];
    delete require.cache[require.resolve('../lib/encryption')];
    const enc = require('../lib/encryption');
    await ok('round-trips', () => { const s = enc.encrypt(PDF); assert.strictEqual(s.algo, 'AES-256-GCM'); assert.strictEqual(s.ciphertext.equals(PDF), false); assert.strictEqual(enc.decrypt({ ciphertext: s.ciphertext, algo: s.algo, iv: s.iv, tag: s.tag }).equals(PDF), true); });
    await ok('tamper fails GCM tag', () => { const s = enc.encrypt(PDF); const t = Buffer.from(s.ciphertext); t[0] ^= 0xff; assert.throws(() => enc.decrypt({ ciphertext: t, algo: s.algo, iv: s.iv, tag: s.tag })); });

    console.log('encryption (no key passthrough)');
    delete process.env.DOCUMENT_ENCRYPTION_KEY;
    delete require.cache[require.resolve('../config/appConfig')];
    delete require.cache[require.resolve('../lib/encryption')];
    const enc2 = require('../lib/encryption');
    await ok("algo 'none', bytes intact", () => { const s = enc2.encrypt(PDF); assert.strictEqual(s.algo, 'none'); assert.strictEqual(s.ciphertext.equals(PDF), true); });

    console.log('virusScan');
    await ok('EICAR → infected', async () => { const r = await virusScan.scan(Buffer.from(virusScan.EICAR, 'latin1')); assert.strictEqual(r.status, 'infected'); assert.strictEqual(virusScan.isPassing(r.status), false); });
    await ok('clean → passing', async () => { const r = await virusScan.scan(PDF); assert.ok(['clean', 'skipped'].includes(r.status)); assert.strictEqual(virusScan.isPassing(r.status), true); });

    console.log('storage (local)');
    const { getStorage, buildObjectKey } = require('../lib/storage');
    const storage = getStorage();
    const key = buildObjectKey({ tenantId: "T-TEST", documentId: "doc-1", versionId: "ver-1", fileName: "invoice.pdf" });
    await ok('put → get → remove', async () => { await storage.put(key, PDF, { contentType: 'application/pdf' }); assert.strictEqual(await storage.exists(key), true); assert.strictEqual((await storage.get(key)).equals(PDF), true); await storage.remove(key); assert.strictEqual(await storage.exists(key), false); });
    await ok('rejects key escaping root', async () => { await assert.rejects(() => storage.get('../../etc/passwd'), /escapes/); });

    console.log(`\n${process.exitCode ? 'FAILED' : 'PASSED'} — ${passed} assertions`);
    fs.rmSync(TMP, { recursive: true, force: true });
})();
