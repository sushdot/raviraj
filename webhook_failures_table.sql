-- ============================================================
-- Raviraj Textiles — webhook_failures table DDL
-- Durable record of failed fulfillment-webhook deliveries, so a retry
-- job or an ops person can act on them even after a server restart
-- (the in-memory diagnostic buffer in server.js is lost on restart —
-- this table is the source of truth).
-- Run this in Supabase Dashboard → SQL Editor → New query
-- ============================================================

create extension if not exists "pgcrypto";

create table if not exists public.webhook_failures (
  id                  uuid primary key default gen_random_uuid(),
  order_receipt_id    text not null,
  razorpay_order_id   text not null,
  webhook_url         text not null,
  error_message       text,
  response_status     int,
  payload             jsonb not null,          -- exact payload that failed to deliver, for replay
  resolved            boolean not null default false,
  retry_count         int not null default 0,
  created_at          timestamptz not null default now(),
  resolved_at         timestamptz
);

create index if not exists idx_webhook_failures_unresolved
  on public.webhook_failures (created_at desc)
  where resolved = false;

create index if not exists idx_webhook_failures_order
  on public.webhook_failures (order_receipt_id);

alter table public.webhook_failures enable row level security;
-- No policies added — only the backend's service_role key can read/write
-- this table, same reasoning as orders_table.sql.

-- ============================================================
-- Example retry query for a future cron job / manual ops pass:
--
--   select * from public.webhook_failures
--   where resolved = false
--   order by created_at asc
--   limit 20;
--
-- After a successful manual/automated retry:
--
--   update public.webhook_failures
--   set resolved = true, resolved_at = now()
--   where id = '...';
-- ============================================================
