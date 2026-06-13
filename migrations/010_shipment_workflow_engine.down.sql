-- Down migration for 010 — Shipment Workflow State Machine.
-- Drops in FK-dependency order (children before parents).
DROP TABLE IF EXISTS tradeops.workflow_webhook_deliveries;
DROP TABLE IF EXISTS tradeops.workflow_transitions;
DROP TABLE IF EXISTS tradeops.workflow_webhooks;
DROP TABLE IF EXISTS tradeops.shipment_workflows;
