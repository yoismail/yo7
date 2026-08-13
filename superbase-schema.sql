-- Yo7 Foods — Supabase schema for accounts + order history
-- Run this once in your Supabase project: Dashboard -> SQL Editor -> New query -> paste this -> Run

-- ============ PROFILES ============
-- Extends Supabase's built-in auth.users with the extra fields we need.
create table public.profiles (
  id uuid references auth.users on delete cascade primary key,
  full_name text,
  created_at timestamptz default now()
);

alter table public.profiles enable row level security;

create policy "Users can view own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- Auto-creates a profile row the moment someone signs up, so you never
-- have to remember to do it from the app.
create function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, new.raw_user_meta_data->>'full_name');
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();


-- ============ ORDERS ============
create table public.orders (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users on delete set null,
  order_number text,
  status text not null default 'placed'
    check (status in ('placed', 'processing', 'out_for_delivery', 'delivered', 'cancelled')),
  items jsonb not null,
  subtotal numeric(10,2) not null,
  delivery_fee numeric(10,2) not null default 0,
  discount numeric(10,2) not null default 0,
  total numeric(10,2) not null,
  delivery_name text,
  delivery_address text,
  delivery_phone text,
  notes text,
  created_at timestamptz default now()
);

alter table public.orders enable row level security;

-- Customers can only ever see or create their own orders.
create policy "Users can view own orders"
  on public.orders for select
  using (auth.uid() = user_id);

create policy "Users can insert own orders"
  on public.orders for insert
  with check (auth.uid() = user_id);

-- No update/delete policy for customers on purpose, only an admin should
-- change an order's status. That comes with the admin catalog editor work.
