# Shipment Workflow State Machine

> War Room 4, Prompt 2 — a deterministic, event-driven workflow engine for the
> shipment lifecycle. Lives in schema `tradeops` (migration `010`), alongside the
> Trade Operations foundation (`009`).

## What it is

A back-office orchestration state machine that drives a shipment through its
operational lifecycle. It is a **separate layer** from the physical
`tradeops.shipments.status` (`booked` / `in_transit` / `delivered` / …): the
workflow models the *process* (collect docs → verify → compliance → customs →
freight → dispatch → deliver → complete), the shipment row models the *physical
movement*. A workflow may optionally bind to a `shipment_id` and/or
`trade_operation_id`.

## States

```
CREATED
  → DOCUMENT_COLLECTION
  → DOCUMENT_VERIFICATION
  → COMPLIANCE_CHECK
  → HS_CLASSIFICATION
  → CUSTOMS_READY
  → FREIGHT_BOOKED
  → DISPATCH_READY
  → DISPATCHED
  → IN_TRANSIT
  → DELIVERED
  → COMPLETED        (terminal)
FAILED               (terminal — reachable from any non-terminal state)
```

`status` is a coarse roll-up of `current_state`: `active` | `completed` | `failed`.

## Transition rules

The state machine ([`service/workflow/stateMachine.js`](../service/workflow/stateMachine.js))
is **pure** — no DB, no clock, no randomness — so it is exhaustively unit-tested.
Every event maps `(from, event) → to` as a function, which makes the machine
deterministic.

| Event | From → To | Kind |
|---|---|---|
| `collect_documents` | CREATED → DOCUMENT_COLLECTION | forward |
| `submit_documents` | DOCUMENT_COLLECTION → DOCUMENT_VERIFICATION | forward |
| `verify_documents` | DOCUMENT_VERIFICATION → COMPLIANCE_CHECK | forward |
| `reject_documents` | DOCUMENT_VERIFICATION → DOCUMENT_COLLECTION | rework |
| `clear_compliance` | COMPLIANCE_CHECK → HS_CLASSIFICATION | forward |
| `classify_hs` | HS_CLASSIFICATION → CUSTOMS_READY | forward |
| `book_freight` | CUSTOMS_READY → FREIGHT_BOOKED | forward |
| `ready_dispatch` | FREIGHT_BOOKED → DISPATCH_READY | forward |
| `dispatch` | DISPATCH_READY → DISPATCHED | forward |
| `depart` | DISPATCHED → IN_TRANSIT | forward |
| `deliver` | IN_TRANSIT → DELIVERED | forward |
| `complete` | DELIVERED → COMPLETED | terminal |
| `fail` | *any non-terminal* → FAILED | terminal |

Any other `(state, event)` pair is **rejected** before any write
(`INVALID_TRANSITION` / `TERMINAL_STATE` / `UNKNOWN_EVENT` / `UNKNOWN_STATE`).

## Engine guarantees

[`service/workflow/workflowEngine.js`](../service/workflow/workflowEngine.js)
`dispatch(workflowId, event, opts)` runs in **one transaction** and provides:

- **Event-driven** — nothing mutates `current_state` except an applied event.
- **Idempotency** — `(workflow_id, idempotency_key)` is `UNIQUE`. A replayed
  dispatch with the same key returns the already-recorded transition and does
  **not** advance again. Pass it via the `Idempotency-Key` header or
  `idempotency_key` body field.
- **Retry-safe / no lost updates** — the workflow row is loaded
  `SELECT … FOR UPDATE` (serialises concurrent dispatches) and saved with an
  optimistic `version` guard (`WHERE version = N`). A crash before `COMMIT`
  leaves **no** partial state.
- **Invalid-transition blocking** — the pure `decide()` rejects illegal/terminal
  transitions before any row is written (the txn rolls back).
- **Append-only event log** — every applied transition is an immutable row in
  `tradeops.workflow_transitions` with a gapless per-workflow `seq`.

## REST API

Base path: `/v1/shipment_workflows` (also `/api/v1/...`). All routes require a
gateway-issued identity; responses use the standard `{ success, data, meta }`
envelope. Tenant isolation is enforced both in the controller (ownership) and at
the DB (RLS).

| Method & path | Purpose |
|---|---|
| `GET /definition` | The full state-machine descriptor (states, events, transitions) — public. |
| `POST /` | Create a workflow in `CREATED`. Body: `shipment_id?`, `trade_operation_id?`, `reference_no?`, `metadata?`. |
| `GET /` | List (tenant-scoped, paginated). Filters: `state`, `status`, `shipment_id`, `trade_operation_id`. |
| `GET /:id` | Detail + `allowed_events`, `next_forward_state`, `is_terminal`. |
| `GET /:id/transitions` | The append-only event log (ascending `seq`). |
| `POST /:id/transitions` | **Dispatch an event.** Body: `event` (required), `reason?`, `payload?`, `idempotency_key?`. Honours the `Idempotency-Key` header. |
| `POST /:id/advance` | Advance one canonical step forward (no branching). |
| `GET /:id/deliveries` | Webhook delivery log for the workflow. |

### Dispatch example

```bash
curl -X POST /v1/shipment_workflows/$ID/transitions \
  -H 'Idempotency-Key: 2f9c…' \
  -H 'Content-Type: application/json' \
  -d '{ "event": "collect_documents", "reason": "kickoff" }'
```

`201` on apply, `200` on idempotent replay. On an illegal transition: `409` with
`{ code: "INVALID_TRANSITION", details: { from, allowedEvents } }`.

## Webhooks

Tenants register a subscription; every matching transition fans out a signed POST.

| Method & path | Purpose |
|---|---|
| `POST /webhooks` | Register. Body: `url` (https), `secret` (≥16 chars), `event_filters?`, `description?`. |
| `GET /webhooks` | List (secret never returned). |
| `DELETE /webhooks/:id` | Deactivate (soft-delete). |

**Filters** (`event_filters`) — empty `[]` means *all* events. Otherwise an
allowlist of: an event name (`"dispatch"`), `"entered:<STATE>"`
(e.g. `"entered:DELIVERED"`), or `"status:failed"` / `"status:completed"`.

**Delivery** — on each matching transition the engine writes a `pending`
`workflow_webhook_deliveries` row (inside the transaction) and, **after commit**,
enqueues a job on the BullMQ `workflow_webhook` queue. The worker
([`service/workflow/webhookDispatcher.js`](../service/workflow/webhookDispatcher.js)
via `queue/workers.js`) signs the body `HMAC-SHA256(secret, body)`, POSTs it, and
advances the row to `delivered` / `failed`. It inherits the queue's bounded
retries + exponential backoff + dead-letter replay, and the shared SSRF guard
(https-only, private/loopback hosts blocked).

Delivered request headers:

```
X-Baalvion-Signature: <hex hmac-sha256 of the raw body>
X-Baalvion-Event:     shipment_workflow.<event>
X-Baalvion-Delivery:  <delivery uuid>
```

Body:

```json
{
  "type": "shipment_workflow.dispatch",
  "workflow_id": "…", "reference_no": "WF-…",
  "shipment_id": null, "trade_operation_id": null,
  "from_state": "DISPATCH_READY", "to_state": "DISPATCHED",
  "status": "active", "seq": 8,
  "occurred_at": "2026-06-11T…Z", "tenant_id": "T-…"
}
```

Verify on the receiver by recomputing `HMAC-SHA256(secret, rawBody)` and
comparing in constant time against `X-Baalvion-Signature`.

## Data model (migration `010`)

- `tradeops.shipment_workflows` — one state-machine instance per shipment.
  Soft-deleted, optimistic-locked (`version`), tenant-scoped (RLS + ALS hooks).
- `tradeops.workflow_transitions` — append-only event log; `UNIQUE (workflow_id,
  idempotency_key)` and `UNIQUE (workflow_id, seq)`.
- `tradeops.workflow_webhooks` — subscriptions (secret excluded from reads by a
  default scope).
- `tradeops.workflow_webhook_deliveries` — per-(transition × subscription)
  delivery audit trail.

All four enforce fail-closed RLS tenant isolation (migration 008/009 style).

## Tests

[`tests/shipment-workflow.test.js`](../tests/shipment-workflow.test.js):

1. **Pure state machine** (no DB, always runs) — determinism, full happy path,
   invalid/terminal blocking, `fail` from every non-terminal state, rework loop.
2. **Engine (DB-backed)** — create + advance, idempotent replay, invalid-transition
   blocking with unchanged state, full-lifecycle event-log persistence, failure
   reason capture. Skips gracefully when no DB is reachable.
