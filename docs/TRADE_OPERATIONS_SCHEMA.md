# Trade Operations Cloud — Core Schema (War Room 4, Prompt 1)

Production-grade, multi-tenant Trade Operations module. Lives in its **own
`tradeops` Postgres schema** so it never collides with the legacy
`trade.shipments` (INTEGER-PK, wired into the orders flow).

- **Stack:** Sequelize models + raw-SQL migrations (`migrate.js` runner), matching
  the rest of `trade-service`. (Not Prisma/TypeORM — that would fork the stack.)
- **Migration:** `migrations/009_tradeops_foundation.sql` (+ `.down.sql`)
- **Models:** `models/tradeops/*.js`, registered in `models/index.js`
- **Seed:** `seedTradeOps.js`

## Entity relationships

```
trade_operations (1) ──< (N) shipments
      │                        │
      │                        ├──< (N) shipment_events          [append-only, high volume]
      │                        ├──< (N) shipment_documents       ──┐
      │                        └──< (N) shipment_status_history    │ (also linked to operation)
      └────────────────────────────────< (N) shipment_documents ──┘
```

| Parent | Child | FK | On delete |
|--------|-------|----|-----------|
| trade_operations | shipments | `shipments.trade_operation_id` | CASCADE |
| shipments | shipment_events | `shipment_events.shipment_id` | CASCADE |
| shipments | shipment_documents | `shipment_documents.shipment_id` | CASCADE |
| trade_operations | shipment_documents | `shipment_documents.trade_operation_id` | CASCADE (nullable) |
| shipments | shipment_status_history | `shipment_status_history.shipment_id` | CASCADE |

All FKs are strict (`REFERENCES … ON DELETE CASCADE`); cascade only fires on a hard
purge — normal lifecycle uses soft delete.

## Conventions on every table

- **UUID PK** — `id uuid DEFAULT gen_random_uuid()` (PG13+ core).
- **Tenant isolation (mandatory)** — `tenant_id text NOT NULL`, enforced two ways:
  1. **DB Row-Level Security** — `ENABLE` + `FORCE` RLS + a `tenant_isolation`
     policy keyed on the `app.current_tenant` GUC. Fail-closed: under the runtime
     role `baalvion_app` a query with no tenant GUC returns zero rows. The
     `app.tenant_bypass` escape hatch is honoured **only** for non-`baalvion_app`
     roles (admin tooling), so an injection on the runtime connection can't defeat
     it. (Mirrors migration 008.)
  2. **App-layer hooks** — `models/index.js` auto-injects the tenant filter on
     reads and stamps it on writes via AsyncLocalStorage request context.
- **Audit fields** — `created_at`, `updated_at` (Sequelize-managed), plus
  `created_by` / `updated_by` attribution.
- **Soft delete** — `deleted_at` / `deleted_by` via Sequelize `paranoid: true`.
  Partial indexes (`WHERE deleted_at IS NULL`) keep the active-row path lean.
- **Optimistic concurrency** — `version integer` (`version: true`) on the mutable
  aggregates (`trade_operations`, `shipments`, `shipment_documents`).
- `shipment_events` and `shipment_status_history` are **append-only** (events keep
  soft-delete for retraction; status-history is fully immutable).

## Indexing for 10M+ scale

- Composite `(tenant_id, status)` partials for tenant-scoped list views.
- FK columns indexed for join/detail access.
- **BRIN** indexes on append-only time columns (`created_at`, `occurred_at`) —
  near-free range pruning at high volume.
- Partial **unique** constraints: `(tenant_id, reference_no)`, `(tenant_id,
  shipment_no)`, `(tenant_id, tracking_number)` — all `WHERE deleted_at IS NULL`,
  so the same business key may be reused across tenants and after deletion.

### Forward path: partitioning `shipment_events`

`shipment_events` is the highest-cardinality table (10M+). The production move is
**declarative RANGE partitioning on `occurred_at`** (monthly partitions) with a
`pg_partman`/cron retention policy. The current shape is partition-ready (no
cross-partition unique constraint required; PK stays `id`). Convert with a
`PARTITION BY RANGE (occurred_at)` table swap when event volume crosses the
single-table comfort zone (~50–100M rows); the BRIN index keeps it healthy until
then.

## Verification (run against a live DB)

```bash
node migrate.js          # applies 009 (and unblocks 008)
node seedTradeOps.js     # seeds 2 tenants, full operation→shipment→events graph
```

Verified: 5 RLS-forced tables, 5 FKs, 24 indexes, 5 tenant-isolation policies;
eager-loaded operation→shipment→events/documents/history graph; tenant
partitioning (T-DEMO=2, T-ACME=1); soft delete (active=2, incl-deleted=3).
