'use strict';
/**
 * S3-compatible storage driver — AWS S3, MinIO, Cloudflare R2, DigitalOcean Spaces,
 * or any S3 API endpoint (config.documents.s3). The @aws-sdk packages are
 * lazy-required the first time this driver is used, so a deployment running the
 * local driver never needs them installed.
 *
 * Server-side encryption at rest (SSE-S3 / SSE-KMS) is applied when DOC_S3_SSE is
 * set. That is independent of the app-level AES-256-GCM envelope (lib/encryption.js):
 * use either or both. Presigned download URLs are only issued for objects that are
 * NOT app-level-encrypted (the controller enforces this) — a presigned URL to an
 * envelope-encrypted object would hand the client ciphertext it cannot open.
 */
const config = require('../../config/appConfig');

const name = 's3';

let _client = null;
let _sdk = null;

function sdk() {
    if (_sdk) return _sdk;
    try {
        // eslint-disable-next-line global-require
        const clientS3 = require('@aws-sdk/client-s3');
        // eslint-disable-next-line global-require
        const presigner = require('@aws-sdk/s3-request-presigner');
        _sdk = { ...clientS3, getSignedUrl: presigner.getSignedUrl };
        return _sdk;
    } catch (err) {
        throw new Error(
            'S3 storage driver requires @aws-sdk/client-s3 and @aws-sdk/s3-request-presigner. '
            + 'Install them, or set DOC_STORAGE_PROVIDER=local. Original error: ' + err.message,
        );
    }
}

function client() {
    if (_client) return _client;
    const { S3Client } = sdk();
    const { region, endpoint, forcePathStyle, accessKeyId, secretAccessKey } = config.documents.s3;
    _client = new S3Client({
        region,
        endpoint: endpoint || undefined,
        forcePathStyle: Boolean(forcePathStyle),
        credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
    });
    return _client;
}

function sseParams() {
    const { serverSideEncryption, kmsKeyId } = config.documents.s3;
    if (!serverSideEncryption) return {};
    const params = { ServerSideEncryption: serverSideEncryption };
    if (serverSideEncryption === 'aws:kms' && kmsKeyId) params.SSEKMSKeyId = kmsKeyId;
    return params;
}

async function put(key, buffer, opts = {}) {
    const { PutObjectCommand } = sdk();
    const Bucket = config.documents.s3.bucket;
    const res = await client().send(new PutObjectCommand({
        Bucket,
        Key: key,
        Body: buffer,
        ContentType: opts.contentType || 'application/octet-stream',
        Metadata: opts.metadata || undefined,
        ...sseParams(),
    }));
    return { provider: name, bucket: Bucket, key, etag: res.ETag || null, size: buffer.length, contentType: opts.contentType || null };
}

async function get(key) {
    const { GetObjectCommand } = sdk();
    const res = await client().send(new GetObjectCommand({ Bucket: config.documents.s3.bucket, Key: key }));
    const chunks = [];
    for await (const chunk of res.Body) chunks.push(chunk);
    return Buffer.concat(chunks);
}

async function remove(key) {
    const { DeleteObjectCommand } = sdk();
    await client().send(new DeleteObjectCommand({ Bucket: config.documents.s3.bucket, Key: key }));
}

async function exists(key) {
    const { HeadObjectCommand } = sdk();
    try { await client().send(new HeadObjectCommand({ Bucket: config.documents.s3.bucket, Key: key })); return true; } catch { return false; }
}

/**
 * Time-limited presigned GET URL with a download filename. Only call this for
 * objects stored WITHOUT app-level envelope encryption (the controller checks).
 */
async function getSignedDownloadUrl(key, opts = {}) {
    const { GetObjectCommand, getSignedUrl } = sdk();
    const fileName = opts.fileName ? `attachment; filename="${opts.fileName.replace(/"/g, '')}"` : undefined;
    const command = new GetObjectCommand({
        Bucket: config.documents.s3.bucket,
        Key: key,
        ResponseContentDisposition: fileName,
        ResponseContentType: opts.contentType || undefined,
    });
    return getSignedUrl(client(), command, { expiresIn: opts.expiresIn || config.documents.signedUrlTtlSeconds });
}

module.exports = { name, put, get, remove, exists, getSignedDownloadUrl };
