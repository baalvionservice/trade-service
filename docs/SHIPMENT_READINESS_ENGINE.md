# Shipment Readiness Score Engine (War Room 4, Prompt 6)

A weighted, event-driven scoring engine that answers **"how close is this shipment
to a clean, low-risk hand-off?"** as a single `readiness_score` (0–100) plus the
four component scores the prompt requires, persisted as an append-only time series,
served from a cache, and recalculated on the events that change it.

## Outputs

Every computation emits five numbers (each `0–100`, higher is better):

| Output | Meaning |
|--------|---------|
| `readiness_score` | The weighted blend of the four components below. |
| `compliance_score` | Progress along the linear workflow lifecycle. |
| `documentation_score` | Verified trade documents vs. the required set. |
| `logistics_score` | Completeness of carrier / tracking / routing data. |
| `risk_score` | **Safety** score (100 = no risk): danger signals subtract. |

Plus: `band` (high ≥ 80 / medium 50–79 / low < 50), `capped`, `weights`,
`components`, `blockers[]`, `blocker_count`, `engine_version`, `trigger`.

## Weighted model

```
readiness = documentation·0.25 + compliance·0.25 + logistics·0.20 + risk·0.30
```

Weights sum to 100 (`service/readiness/scoring.js → WEIGHTS`). A shipment in a
hard-failed state is **clamped** so the dashboard never shows a falsely-green score:

- `cancelled` shipment or `FAILED` workflow → `readiness ≤ 10`.
- `customs_hold` / `delayed` / `exception` → `readiness ≤ 60`.

### Risk signals (`risk_score = (1 − Σpenalty)·100`, penalty clamped to 1)

| Signal | Penalty |
|--------|---------|
| Failed document validation w/ a critical finding | 0.60 |
| High-severity document validation finding(s) | 0.25 (×, capped 0.50) |
| Workflow in `FAILED` | 0.80 |
| Document-rework loops (`retry_count`) | 0.10 each (cap 0.30) |
| Troubled shipment status | 0.30 |
| Cancelled shipment | 1.00 |
| Overdue vs. ETA | up to 0.30 (scaled over 7 days) |
| Sanctions / compliance hold | 0.70 |
| Uninsured high-value (≥ 100 000) consignment | 0.20 |

## Architecture

```
service/readiness/
  scoring.js          PURE weighted scorer — deterministic, clock-injected, no I/O
  readinessEngine.js  DB-backed orchestrator — assemble → score → persist → cache
  index.js            public surface { scoring, engine }
models/tradeops/shipment_readiness.js     Sequelize model (append-only snapshots)
migrations/012_shipment_readiness_engine.sql   tradeops.shipment_readiness_scores + RLS
controller/readinessController.js / routes/readinessRoutes.js   HTTP surface
```

- **PURE core** (`scoring.js`) — the entire scoring policy, exhaustively unit-tested
  with an injected clock. Zero DB/network so it stays deterministic.
- **Orchestrator** (`readinessEngine.js`) — loads the operation, documents, workflow,
  latest document-validations (best-effort — sibling engine, may be un-migrated) and
  an insurance/sanctions signal from metadata, runs the scorer, persists a snapshot
  and refreshes the cache.

## Persistence

`tradeops.shipment_readiness_scores` is **append-only**: each recalculation inserts a
new row, so the table is a real-time **trend + audit** of a shipment's readiness. The
latest row (by `created_at`) is the live score. Tenant-isolated by **fail-closed RLS**
(mirrors migrations 008/009/010/011). Scalar `*_score` columns are denormalized for
cheap filtering; the full `components` / `blockers` / `weights` live in JSONB.

## Caching layer

The live score is cached per `(tenant, shipment)` in Redis
(`baalvion:<tenant>:readiness:latest:<shipmentId>`, TTL 60 s) via the shared
`cache` module. `getLatest()` is cache-aside; every recalculation **refreshes** the
cache with the just-computed score (real-time update). Redis-down degrades to a
no-op — the score is always recomputable from the DB.

## Event-triggered recalculation

Recalculation is driven by the events that change a shipment's inputs. The hooks are
**best-effort and post-commit** — they never throw into the triggering request:

| Trigger | Source |
|---------|--------|
| `workflow_transition` | `workflowEngine.dispatch()` after a committed transition. |
| `document_validation` | `validationEngine.validateDocument()` after a verdict is persisted. |
| `api` / `manual` | `POST /recalculate`, or the first-read seed. |
| `shipment_status` | `triggerRecalc()` (generic hook for status changes). |

## API

Mounted at `/v1/shipment_readiness` (gateway identity required; tenant ownership
enforced in the controller + RLS at the DB).

| Method & path | Purpose |
|---------------|---------|
| `GET /definition` | Public scoring-model descriptor (weights, bands, risk signals). |
| `GET /:shipmentId` | Live, cached readiness (seeds a snapshot on first read). |
| `POST /:shipmentId/recalculate` | Force a fresh computation + persisted snapshot. |
| `GET /:shipmentId/history` | Paginated snapshot time series (the trend). |
| `GET /` | List persisted snapshots across the tenant (filter by band/op/trigger). |

## Verification

`jest` is broken repo-wide, so the gates are standalone harnesses:

```
node tests/shipment-readiness.verify.js   # 22 PURE scoring assertions
node tests/shipment-readiness.live.js     # 8 live-DB: persist + cache + history
                                          #   + workflow-transition recalc + RLS
```

`tests/shipment-readiness.test.js` mirrors the pure assertions in jest form for when
the runner is fixed.
