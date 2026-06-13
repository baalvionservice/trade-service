# Document Management System — Production File Engine

War Room 4, Prompt 4. A secure, multi-tenant document store for trade documents,
built into `trade-service`. Mounted at **`/v1/trade_documents`**.

> This is distinct from the legacy `/v1/documents` route (`trade.documents`, a light
> metadata-only pointer store). The new engine lives in schema `tradeops` with real
> file storage, versioning, encryption, and virus scanning.

---

## What it does

| Capability | Implementation |
|---|---|
| **Secure upload** | Raw-binary or base64-JSON upload, validated through a magic-byte + allowlist + size pipeline before a byte is stored. |
| **S3-compatible storage** | Pluggable driver (`local` for dev, `s3` for AWS S3 / MinIO / R2 / Spaces). Selected by `DOC_STORAGE_PROVIDER`; business code depends only on the storage contract. |
| **Versioning** | Every upload appends an immutable `document_versions` row (`UNIQUE (document_id, version_no)`); the document tracks `current_version` + `latest_version_id`. |
| **Metadata schema** | Structural metadata extracted from the bytes (PDF version/page-count/encryption flag, image dimensions, SHA-256, detected MIME) into `extracted_metadata`. |
| **Virus-scan hook** | Async scan on every upload; document stays `scanning` until released to `available` (clean/skipped) or `quarantined` (infected). Placeholder rejects EICAR; ClamAV backend is one config flag away. |
| **File encryption** | App-level AES-256-GCM envelope encryption (authenticated). Optional S3 server-side encryption (SSE-S3 / SSE-KMS) on top. |
| **File validation pipeline** | `lib/documentValidation.js` — MIME allowlist, magic-byte sniff vs declared type (anti content-type-spoof), size ceiling, filename sanitization (anti path-traversal). |
| **Shipment linkage** | `documents.shipment_id` / `trade_operation_id` FKs (`ON DELETE SET NULL`) into `tradeops.shipments` / `tradeops.trade_operations`. |
| **Chain of custody** | Append-only `document_events` (created, version_uploaded, scan_completed, downloaded, verified, rejected, deleted) + entries in the global tamper-evident audit chain. |

Document types (the `doc_type` enum): `commercial_invoice` (Invoice), `packing_list`
(Packing List), `bill_of_lading` (Bill of Lading), `certificate_of_origin`
(Certificate of Origin), `insurance_document` (Insurance Docs), `other`.

---

## Architecture

```
                 ┌─────────────────────── controller/tradeDocumentController.js
HTTP /v1/trade_documents                  (auth + tenant ownership + HTTP shape)
                 │
                 ▼
         service/documents/documentEngine.js   ← orchestration core
                 │   1 validate  2 extract  3 encrypt  4 store  5 persist  6 enqueue scan
   ┌─────────────┼───────────────┬───────────────┬──────────────────┐
   ▼             ▼               ▼               ▼                  ▼
lib/document  lib/metadata   lib/encryption   lib/storage/*      queue 'document_scan'
Validation    Extraction     (AES-256-GCM)    (local | s3)             │
                                                                       ▼
                                              service/documents/scanProcessor.js
                                              (worker: fetch → decrypt → scan →
                                               release / quarantine)
```

Tables (migration `011_document_engine.sql`, schema `tradeops`, fail-closed RLS):
`documents`, `document_versions`, `document_events`.

---

## API

All routes require auth (gateway identity or bearer). All are tenant-scoped; an
admin/owner/super_admin sees across tenants.

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/v1/trade_documents/meta/capabilities` | Doc types, classifications, allowed MIME, size limit, encryption/scan posture. |
| `POST` | `/v1/trade_documents` | Create a document (metadata only → `draft`). |
| `GET`  | `/v1/trade_documents` | List (filters: `doc_type`, `status`, `classification`, `shipment_id`, `trade_operation_id`; paginated). |
| `GET`  | `/v1/trade_documents/:id` | Detail + versions. |
| `DELETE` | `/v1/trade_documents/:id` | Soft delete (paranoid). |
| `POST` | `/v1/trade_documents/:id/versions` | **Upload a new version** (the file engine). |
| `GET`  | `/v1/trade_documents/:id/versions` | List versions. |
| `GET`  | `/v1/trade_documents/:id/download` | Download latest (or `?version=N`). |
| `GET`  | `/v1/trade_documents/:id/versions/:versionId/download` | Download a specific version. |
| `POST` | `/v1/trade_documents/:id/versions/:versionId/rescan` | Re-queue a scan (recovery). |
| `PATCH`| `/v1/trade_documents/:id/verify` | Mark verified (manual review). |
| `PATCH`| `/v1/trade_documents/:id/reject` | Mark rejected. |
| `GET`  | `/v1/trade_documents/:id/events` | Chain of custody. |

### Upload transport

The upload endpoint accepts either:

1. **Raw binary** (preferred — supports large files): send the file bytes as the
   request body with the file's `Content-Type` and an `X-File-Name` header.
   ```bash
   curl -X POST .../v1/trade_documents/$ID/versions \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/pdf" \
     -H "X-File-Name: invoice-2026-001.pdf" \
     --data-binary @invoice.pdf
   ```
2. **JSON envelope** (convenient for small files / testing):
   ```json
   { "file_base64": "JVBERi0xLj...", "file_name": "invoice.pdf", "mime_type": "application/pdf" }
   ```

After upload the document is `scanning`; poll `GET /:id` until `status` becomes
`available` (or `quarantined`).

---

## Configuration

| Env var | Default | Notes |
|---|---|---|
| `DOC_STORAGE_PROVIDER` | `local` | `local` or `s3`. |
| `DOC_STORAGE_LOCAL_DIR` | `<svc>/.storage/documents` | Local driver root. |
| `DOC_S3_BUCKET` | `baalvion-trade-documents` | |
| `DOC_S3_REGION` | `us-east-1` | |
| `DOC_S3_ENDPOINT` | — | Set for MinIO / R2 / Spaces. |
| `DOC_S3_FORCE_PATH_STYLE` | `false` | `true` for MinIO. |
| `DOC_S3_ACCESS_KEY_ID` / `DOC_S3_SECRET_ACCESS_KEY` | — | Falls back to `AWS_*`. |
| `DOC_S3_SSE` | — | `AES256` or `aws:kms` for at-rest SSE. |
| `DOC_S3_KMS_KEY_ID` | — | When `DOC_S3_SSE=aws:kms`. |
| `DOCUMENT_ENCRYPTION_KEY` | — | base64 32-byte key → AES-256-GCM envelope. `openssl rand -base64 32`. |
| `DOC_MAX_UPLOAD_BYTES` | `26214400` (25 MiB) | Upload ceiling. |
| `DOC_SIGNED_URL_TTL` | `300` | Presigned download URL lifetime (s). |
| `DOC_VIRUS_SCAN_PROVIDER` | `none` | `clamav` for a real scan; `none` = placeholder (still rejects EICAR). |
| `CLAMAV_HOST` / `CLAMAV_PORT` | `127.0.0.1` / `3310` | clamd INSTREAM target. |

### S3 requires the AWS SDK

The S3 driver lazy-requires `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`
(declared in `package.json`). They are only loaded when `DOC_STORAGE_PROVIDER=s3`,
so the local driver boots without them.

---

## Security notes

- **Tenant isolation**: RLS fail-closed on all three tables (migration 008/009/010
  pattern) + the service's per-model tenant hooks. Ownership is re-checked in the
  controller; cross-tenant access returns `404` (no existence leak).
- **Anti content-type spoof**: the declared MIME must be corroborated by the file's
  magic bytes; a `.pdf`-named PNG/executable is rejected.
- **Path traversal**: filenames are sanitized to a basename; storage keys are
  validated to stay under the storage root.
- **Quarantine gate**: downloads of `quarantined`/`infected` objects are blocked
  (`403`); downloads while `scan_status = pending` return `409`.
- **Encryption + presigned URLs**: presigned URLs are only issued for *unencrypted*
  objects. App-level-encrypted objects always stream back through the service so the
  client receives plaintext, never ciphertext it cannot open.
- **Integrity**: the plaintext SHA-256 is stored per version, independent of
  encryption — tamper-evidence survives a storage-backend swap.

---

## Tests

`tests/document-engine.test.js` (jest) and `tests/document-engine.smoke.js`
(standalone Node) cover the validation pipeline, metadata extraction, AES-256-GCM
round-trip + tamper detection, the EICAR scan gate, and the local storage round-trip.

> The repo's jest is currently broken globally (`jest-runtime@30` vs `jest@29` →
> `clearMocksOnScope` on `resetModules`). Until that's fixed, run:
> ```
> node tests/document-engine.smoke.js
> ```
