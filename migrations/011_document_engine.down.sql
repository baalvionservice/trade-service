-- 011 DOWN — drop the Document Management System tables (War Room 4, Prompt 4).
-- Drop children before parents; document_versions/document_events both FK documents.
DROP TABLE IF EXISTS tradeops.document_events CASCADE;
DROP TABLE IF EXISTS tradeops.document_versions CASCADE;
DROP TABLE IF EXISTS tradeops.documents CASCADE;
