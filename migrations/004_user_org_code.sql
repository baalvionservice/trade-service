-- 004 — participant org identity on users (dual-party trade authorization).
ALTER TABLE trade.users ADD COLUMN IF NOT EXISTS org_code varchar(64);
-- Map the demo identity to its participant org (Apex Renewable = COMP-101).
UPDATE trade.users SET org_code = 'COMP-101' WHERE email = 'seller@apex.demo' AND org_code IS NULL
