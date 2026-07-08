-- ============================================================
-- Raviraj Textiles — products table DDL
-- Backs the GET /api/products endpoint that store.html now loads
-- its catalogue from dynamically (instead of a hardcoded array).
-- Run this in Supabase Dashboard → SQL Editor → New query
-- ============================================================

create extension if not exists "pgcrypto";

create table if not exists public.products (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  category          text not null
                      check (category in ('cotton','silk','wedding','soft-silk','fancy','printed')),
  retail_price      numeric(10,2) not null,   -- price for a single retail piece
  wholesale_price   numeric(10,2) not null,   -- price per piece at wholesale qty (6+)
  mrp               numeric(10,2) not null,   -- struck-through "compare at" price
  tag               text,                     -- e.g. 'Bestseller', 'New', 'Bridal' — nullable
  swatch_class      text not null default 'pg1', -- CSS class for the placeholder swatch color
  in_stock          boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

drop trigger if exists trg_products_updated_at on public.products;
create trigger trg_products_updated_at
  before update on public.products
  for each row execute function public.set_updated_at(); -- reuses the function from orders_table.sql

create index if not exists idx_products_category on public.products (category);
create index if not exists idx_products_in_stock on public.products (in_stock);

alter table public.products enable row level security;

-- Unlike orders/webhook_failures, the product catalogue is meant to be
-- PUBLIC read-only data (anyone visiting the site should see it). Add an
-- explicit read policy for the anon key, but keep writes locked to the
-- service_role key used by the backend admin routes.
create policy "Public can read in-stock products"
  on public.products for select
  using (in_stock = true);

-- ============================================================
-- Starter data — replace with your real design catalogue.
-- (Matches the FALLBACK_PRODUCTS array in index.html so the site
-- looks identical whether it's reading from Supabase or the fallback.)
-- ============================================================
insert into public.products (name, category, retail_price, wholesale_price, mrp, tag, swatch_class) values
  ('Annapurna Cotton Saree', 'cotton', 780, 470, 899, 'Bestseller', 'pg1'),
  ('Bengal Cotton Saree', 'cotton', 675, 405, 999, null, 'pg2'),
  ('Women''s Cotton Khesh Applique Saree', 'cotton', 899, 540, 999, 'New Arrival', 'pg3'),
  ('Banarasi Retta Pettu Saree', 'wedding', 900, 540, 1450, 'Bridal', 'pg4'),
  ('Subatra Semi Jalkot Silk Saree', 'wedding', 2000, 1200, 2500, 'Premium', 'pg5'),
  ('Kattan Silk Checked Saree', 'silk', 850, 510, 1299, null, 'pg6'),
  ('Banarasi Kathan Georgette Silk', 'silk', 1099, 660, 1399, null, 'pg7'),
  ('Taasar Silk Saree', 'silk', 750, 450, 999, null, 'pg8'),
  ('Tissues Plain Saree', 'soft-silk', 550, 330, 699, null, 'pg9'),
  ('Slate Garden Fancy Silk', 'fancy', 1249, 750, 1499, 'Trending', 'pg10'),
  ('Sclap Mirror Linen Saree', 'fancy', 899, 540, 1199, null, 'pg11'),
  ('Sunflower Linen Saree', 'printed', 299, 180, 399, null, 'pg12')
on conflict do nothing;
