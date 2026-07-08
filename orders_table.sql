-- ============================================================
-- Raviraj Textiles — orders table DDL
-- Run this in Supabase Dashboard → SQL Editor → New query
-- ============================================================

create extension if not exists "pgcrypto"; -- for gen_random_uuid()

create table if not exists public.orders (
  id                   uuid primary key default gen_random_uuid(),
  receipt_id           text not null,                  -- your internal order id, e.g. "ST12345678"
  razorpay_order_id    text not null unique,            -- Razorpay's order_xxxx id
  razorpay_payment_id  text,                            -- filled in once payment is verified
  status               text not null default 'created'
                         check (status in ('created', 'paid', 'failed', 'shipped', 'delivered', 'cancelled')),
  amount               numeric(10, 2) not null,         -- total in rupees (not paise)
  currency             text not null default 'INR',
  customer_name        text not null,
  customer_phone       text not null,
  customer_email       text,
  address              text not null,
  pincode              text,
  items                jsonb not null default '[]'::jsonb, -- [{id, name, qty, price}, ...]
  created_at           timestamptz not null default now(),
  paid_at              timestamptz,
  updated_at           timestamptz not null default now()
);

-- Keep updated_at current on every change
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_orders_updated_at on public.orders;
create trigger trg_orders_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();

-- Helpful indexes for lookups you'll actually run
create index if not exists idx_orders_status on public.orders (status);
create index if not exists idx_orders_phone on public.orders (customer_phone);
create index if not exists idx_orders_created_at on public.orders (created_at desc);

-- ============================================================
-- Row Level Security
-- The backend uses the SERVICE_ROLE key, which bypasses RLS entirely —
-- that's expected and safe *as long as the service role key never
-- reaches the browser*. Enabling RLS here still protects the table
-- from Supabase's anon/public key, in case you ever add client-side
-- Supabase access (e.g. a future customer order-tracking page).
-- ============================================================
alter table public.orders enable row level security;

-- No policies are created here on purpose: with RLS on and zero
-- policies, the anon/public key gets zero access, while your backend's
-- service_role key still has full access. Add narrow, specific
-- policies later if you build a customer-facing tracking page
-- (e.g. "select where customer_phone = current logged-in user's phone").
