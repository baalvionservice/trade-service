-- 009 down — drop the Trade Operations Cloud foundation. Children first (FKs),
-- then the schema. CASCADE on the schema also removes the RLS policies/indexes.
DROP TABLE IF EXISTS tradeops.shipment_status_history;
DROP TABLE IF EXISTS tradeops.shipment_events;
DROP TABLE IF EXISTS tradeops.shipment_documents;
DROP TABLE IF EXISTS tradeops.shipments;
DROP TABLE IF EXISTS tradeops.trade_operations;
DROP SCHEMA IF EXISTS tradeops CASCADE;
