-- ============================================================
-- Phase 1 migration — run AFTER products_table.sql / orders_table.sql
-- already exist. Adds what order automation needs:
--   1. a real stock count per product (so we can decrement it)
--   2. shipment/tracking fields on orders (so we can store what
--      Shiprocket gives us and show it to the customer)
-- Run in Supabase Dashboard -> SQL Editor -> New query
-- ============================================================

-- ---- products: real stock count -----------------------------
alter table public.products
  add column if not exists stock_count integer not null default 20;

-- Backfill: pick a sensible starting number for existing rows.
-- Replace with your real counts whenever you have them.
update public.products set stock_count = 20 where stock_count is null;

-- ---- orders: shipment / tracking fields ----------------------
alter table public.orders
  add column if not exists shiprocket_order_id   text,
  add column if not exists shiprocket_shipment_id text,
  add column if not exists awb_code               text,   -- the tracking number
  add column if not exists courier_name           text,
  add column if not exists tracking_url           text,
  add column if not exists invoice_url            text,
  add column if not exists shipped_at             timestamptz;

create index if not exists idx_orders_awb_code on public.orders (awb_code);
