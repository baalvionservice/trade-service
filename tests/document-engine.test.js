'use strict';
/**
 * Document Management System — unit tests for the file-engine building blocks
 * (War Room 4, Prompt 4). These cover the pure modules (validation, metadata,
 * encryption, virus scan, local storage) and need no DB or Redis, so they run
 * deterministically in CI. The HTTP/DB integration path is exercised end-to-end
 * against a live stack.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// Pin a temp storage dir + small upload limit BEFORE config is required.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-engine-'));
process.env.DOC_STORAGE_LOCAL_DIR = TMP;
process.env.DOC_STORAGE_PROVIDER = 'local';
process.env.DOC_MAX_UPLOAD_BYTES = String(1024 * 1024); // 1 MiB

const validation = require('../lib/documentValidation');
const metadata = require('../lib/metadataExtraction');
const virusScan = require('../lib/virusScan');

// Minimal valid file fixtures (magic bytes + filler).
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('1 0 obj<</Type /Page >>endobj\n'), Buffer.from('%%EOF')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), (() => { const b = Buffer.alloc(8); b.writeUInt32BE(640, 0); b.writeUInt32BE(480, 4); return b; })()]);

describe('documentValidation — magic-byte sniffing', () => {
    test('detects PDF from %PDF header', () => {
        expect(validation.sniffMimeType(PDF)).toBe('application/pdf');
    });
    test('detects PNG from \\x89PNG header', () => {
        expect(validation.sniffMimeType(PNG)).toBe('image/png');
    });
    test('returns null for an unrecognised signature', () => {
        expect(validation.sniffMimeType(Buffer.from('not a real file'))).toBeNull();
    });
});

describe('documentValidation — pipeline', () => {
    test('accepts a valid PDF with matching declared type', () => {
        const r = validation.validateUpload({ buffer: PDF, fileName: 'invoice.pdf', declaredMime: 'application/pdf', docType: 'commercial_invoice' });
        expect(r.ok).toBe(true);
        expect(r.detectedMime).toBe('application/pdf');
        expect(r.errors).toHaveLength(0);
    });

    test('rejects a content-type spoof (declared pdf, bytes are png)', () => {
        const r = validation.validateUpload({ buffer: PNG, fileName: 'fake.pdf', declaredMime: 'application/pdf', docType: 'bill_of_lading' });
        expect(r.ok).toBe(false);
        expect(r.errors.join(' ')).toMatch(/signature/i);
    });

    test('rejects an empty body', () => {
        const r = validation.validateUpload({ buffer: Buffer.alloc(0), fileName: 'x.pdf' });
        expect(r.ok).toBe(false);
    });

    test('rejects an oversized file', () => {
        const big = Buffer.concat([PDF, Buffer.alloc(2 * 1024 * 1024)]); // > 1 MiB limit
        const r = validation.validateUpload({ buffer: big, fileName: 'big.pdf', declaredMime: 'application/pdf' });
        expect(r.ok).toBe(false);
        expect(r.errors.join(' ')).toMatch(/exceeds/i);
    });

    test('rejects a disallowed content type', () => {
        const r = validation.validateUpload({ buffer: PDF, fileName: 'x.exe', declaredMime: 'application/x-msdownload' });
        expect(r.ok).toBe(false);
        expect(r.errors.join(' ')).toMatch(/not allowed/i);
    });

    test('rejects an unknown doc_type', () => {
        const r = validation.validateUpload({ buffer: PDF, fileName: 'x.pdf', declaredMime: 'application/pdf', docType: 'nonsense' });
        expect(r.ok).toBe(false);
        expect(r.errors.join(' ')).toMatch(/doc_type/i);
    });
});

describe('documentValidation — filename sanitization', () => {
    test('strips directory traversal', () => {
        expect(validation.sanitizeFileName('../../etc/passwd')).toBe('passwd');
    });
    test('strips path + shell metacharacters', () => {
        expect(validation.sanitizeFileName('a/b\\c:*?.pdf')).not.toMatch(/[\\/:*?]/);
    });
    test('never returns empty', () => {
        expect(validation.sanitizeFileName('...')).toBe('document');
        expect(validation.sanitizeFileName('')).toBe('document');
    });
});

describe('metadataExtraction', () => {
    test('sha256 is stable + correct length', () => {
        const a = metadata.sha256(PDF);
        const b = metadata.sha256(PDF);
        expect(a).toBe(b);
        expect(a).toHaveLength(64);
    });
    test('extracts PDF version + page count', () => {
        const m = metadata.extract({ buffer: PDF, detectedMime: 'application/pdf', fileName: 'invoice.pdf' });
        expect(m.format).toBe('pdf');
        expect(m.pdfVersion).toBe('1.7');
        expect(m.pageCount).toBe(1);
        expect(m.byteSize).toBe(PDF.length);
    });
    test('extracts PNG dimensions', () => {
        const m = metadata.extract({ buffer: PNG, detectedMime: 'image/png', fileName: 'scan.png' });
        expect(m.width).toBe(640);
        expect(m.height).toBe(480);
    });
});

describe('encryption — AES-256-GCM envelope', () => {
    const KEY = require('crypto').randomBytes(32).toString('base64');
    let enc;
    beforeAll(() => {
        process.env.DOCUMENT_ENCRYPTION_KEY = KEY;
        jest.resetModules();
        // eslint-disable-next-line global-require
        enc = require('../lib/encryption');
    });
    afterAll(() => { delete process.env.DOCUMENT_ENCRYPTION_KEY; jest.resetModules(); });

    test('round-trips encrypt → decrypt', () => {
        const sealed = enc.encrypt(PDF);
        expect(sealed.algo).toBe('AES-256-GCM');
        expect(sealed.iv).toBeTruthy();
        expect(sealed.tag).toBeTruthy();
        expect(sealed.ciphertext.equals(PDF)).toBe(false); // actually encrypted
        const plain = enc.decrypt({ ciphertext: sealed.ciphertext, algo: sealed.algo, iv: sealed.iv, tag: sealed.tag });
        expect(plain.equals(PDF)).toBe(true);
    });

    test('tampered ciphertext fails the GCM auth tag', () => {
        const sealed = enc.encrypt(PDF);
        const tampered = Buffer.from(sealed.ciphertext);
        tampered[0] ^= 0xff;
        expect(() => enc.decrypt({ ciphertext: tampered, algo: sealed.algo, iv: sealed.iv, tag: sealed.tag })).toThrow();
    });
});

describe('encryption — passthrough when no key', () => {
    test("returns algo 'none' and leaves bytes intact", () => {
        jest.resetModules();
        delete process.env.DOCUMENT_ENCRYPTION_KEY;
        // eslint-disable-next-line global-require
        const enc = require('../lib/encryption');
        const sealed = enc.encrypt(PDF);
        expect(sealed.algo).toBe('none');
        expect(sealed.ciphertext.equals(PDF)).toBe(true);
        expect(enc.decrypt({ ciphertext: sealed.ciphertext, algo: 'none' }).equals(PDF)).toBe(true);
    });
});

describe('virusScan — placeholder gate', () => {
    test('rejects the EICAR test file as infected', async () => {
        const eicar = Buffer.from(virusScan.EICAR, 'latin1');
        const r = await virusScan.scan(eicar, { fileName: 'eicar.txt' });
        expect(r.status).toBe('infected');
        expect(virusScan.isPassing(r.status)).toBe(false);
    });
    test('passes a clean file (skipped when no engine configured)', async () => {
        const r = await virusScan.scan(PDF, { fileName: 'invoice.pdf' });
        expect(['clean', 'skipped']).toContain(r.status);
        expect(virusScan.isPassing(r.status)).toBe(true);
    });
});

describe('storage — local provider round trip', () => {
    test('put → get → exists → remove', async () => {
        jest.resetModules();
        // eslint-disable-next-line global-require
        const { getStorage, buildObjectKey } = require('../lib/storage');
        const storage = getStorage();
        const key = buildObjectKey({ tenantId: "T-TEST", documentId: "doc-1", versionId: "ver-1", fileName: "invoice.pdf" });
        await storage.put(key, PDF, { contentType: 'application/pdf' });
        expect(await storage.exists(key)).toBe(true);
        const got = await storage.get(key);
        expect(got.equals(PDF)).toBe(true);
        await storage.remove(key);
        expect(await storage.exists(key)).toBe(false);
    });

    test('rejects a storage key that escapes the root', async () => {
        jest.resetModules();
        // eslint-disable-next-line global-require
        const { getStorage } = require('../lib/storage');
        const storage = getStorage();
        await expect(storage.get('../../etc/passwd')).rejects.toThrow(/escapes/);
    });
});
