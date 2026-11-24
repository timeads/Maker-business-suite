-- Michaels Marketplace, first stage: connect, match listings, and watch.
--
-- A workspace that sells on Michaels can connect its seller account (provider
-- `michaels`, a pasted API key kept in Vault like every other connection).
-- The worker then looks at Michaels about once an hour and writes down:
--   * every sellable SKU the seller has listed there, and which stock item it
--     is (michaels_listings), with pairings a manager typed in by hand
--     (michaels_pairings) deciding first;
--   * what stock and price it WOULD send for each matched listing, and how
--     that differs from what Michaels shows now (michaels_runs.changes);
--   * recent Michaels orders and their lines (michaels_orders,
--     michaels_order_lines), so the page can show what bringing each in
--     would make.
--
-- THIS STAGE CANNOT WRITE to Michaels or to the shop. Nothing in the app
-- sends anything; and the database says so too:
--   * every run is watch-only (a check on the column);
--   * every finished run carries the reason nothing could be sent
--     (send_blocked), worked out here from the rows, not taken from the
--     worker. `michaels_send_blocked` never answers "free to send" in this
--     stage, and answers `unmatched` whenever more than a tenth of the
--     listings have no item: the safety stop the later stages build on;
--   * every order is `observed`. Nothing can be recorded as imported.
--
-- Nothing about a buyer is kept: no name, phone or address. An order is its
-- number, status, dates, totals and lines.

alter table public.connections drop constraint connections_provider_check;
alter table public.connections add constraint connections_provider_check
  check (provider in ('shopify', 'quickbooks', 'meta', 'google', 'stripe', 'easypost', 'ups',
                      'redo', 'google_mail', 'michaels'));

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- One look at Michaels. The claim that makes a look happen once, and the
-- record of what it found.
create table public.michaels_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  -- queued: waiting for the worker. running: the worker has it. done / failed:
  -- finished. A look that was claimed and never finished is marked failed; it
  -- is never tried again by itself.
  status text not null default 'queued'
    check (status in ('queued', 'running', 'done', 'failed')),
  -- schedule: the hourly look. manual: a manager pressed "Look now".
  source text not null default 'schedule' check (source in ('schedule', 'manual')),
  -- This stage only watches, so no run can be recorded as anything else.
  watch_only boolean not null default true check (watch_only),
  requested_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  -- What was read and compared, as counts.
  counts jsonb not null default '{}'::jsonb check (jsonb_typeof(counts) = 'object'),
  -- What would have been sent: [{"kind", "seller_sku", "from", "to", ...}].
  changes jsonb not null default '[]'::jsonb
    check (jsonb_typeof(changes) = 'array' and jsonb_array_length(changes) <= 500),
  -- Why nothing could be sent, as the database saw it when the look finished.
  send_blocked text check (send_blocked is null or send_blocked in ('watch_only', 'unmatched', 'no_scan')),
  error text check (error is null or char_length(error) <= 1000),
  -- A finished look always says why nothing could be sent.
  check (status in ('queued', 'running') or send_blocked is not null)
);
-- One look at a time for a workspace.
create unique index michaels_runs_one_open
  on public.michaels_runs (tenant_id) where status in ('queued', 'running');
create index michaels_runs_tenant_idx on public.michaels_runs (tenant_id, created_at desc);

-- Every sellable SKU the seller has on Michaels, and the stock item it is.
-- A mirror of Michaels' catalog: rows that are no longer there are removed at
-- the end of a complete read.
create table public.michaels_listings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  -- Michaels' ids are long numbers; always text, never numbers.
  michaels_sku_number text not null check (char_length(michaels_sku_number) between 1 and 80),
  primary_sku_number text not null check (char_length(primary_sku_number) between 1 and 80),
  -- The seller's own SKU, exactly as Michaels has it (spaces and capitals
  -- included: updates would address it by this string). Null when Michaels
  -- has none.
  seller_sku text check (seller_sku is null or char_length(seller_sku) between 1 and 200),
  item_name text check (item_name is null or char_length(item_name) <= 300),
  listing_status text check (listing_status is null or char_length(listing_status) <= 40),
  gtin text check (gtin is null or char_length(gtin) <= 40),
  -- The match. No item means unmatched, whatever else the row says.
  stock_item_id uuid references public.stock_items (id) on delete set null,
  matched_by text check (matched_by is null or matched_by in ('hand', 'exact', 'case', 'barcode')),
  problem text check (problem is null or problem in
    ('no_match', 'ambiguous', 'duplicate', 'no_seller_sku', 'pairing_missing')),
  problem_detail text check (problem_detail is null or char_length(problem_detail) <= 300),
  -- What Michaels showed when it was last read, and when that was.
  michaels_qty int,
  michaels_price numeric(14, 2),
  figures_at timestamptz,
  michaels_updated_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_run_id uuid references public.michaels_runs (id) on delete set null,
  unique (tenant_id, michaels_sku_number)
);
create index michaels_listings_seller_sku_idx on public.michaels_listings (tenant_id, seller_sku);
create index michaels_listings_item_idx on public.michaels_listings (tenant_id, stock_item_id);

-- Pairings typed in by hand: this Michaels seller SKU is that item. They win
-- over every matching rule. When the item goes, the pairing stays, pointing
-- at nothing, so the page can say so.
create table public.michaels_pairings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  seller_sku text not null check (char_length(seller_sku) between 1 and 200),
  stock_item_id uuid references public.stock_items (id) on delete set null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (tenant_id, seller_sku)
);

-- Michaels orders, as seen. Only ever observed: this stage brings nothing in.
create table public.michaels_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  order_number text not null check (char_length(order_number) between 1 and 80),
  status text not null check (char_length(status) between 1 and 40),
  state text not null default 'observed' check (state = 'observed'),
  currency text check (currency is null or char_length(currency) <= 8),
  placed_at timestamptz,
  promise_ship_at timestamptz,
  michaels_updated_at timestamptz,
  items_subtotal numeric(14, 2),
  shipping numeric(14, 2),
  tax numeric(14, 2),
  discount numeric(14, 2),
  grand_total numeric(14, 2),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (tenant_id, order_number)
);
create index michaels_orders_tenant_idx on public.michaels_orders (tenant_id, placed_at desc);

create table public.michaels_order_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  order_id uuid not null references public.michaels_orders (id) on delete cascade,
  order_item_id text not null check (char_length(order_item_id) between 1 and 80),
  seller_sku text check (seller_sku is null or char_length(seller_sku) <= 200),
  michaels_sku_number text check (michaels_sku_number is null or char_length(michaels_sku_number) <= 80),
  product_name text check (product_name is null or char_length(product_name) <= 300),
  quantity int not null default 0 check (quantity between 0 and 1000000),
  unit_price numeric(14, 2),
  line_status text check (line_status is null or char_length(line_status) <= 40),
  unique (tenant_id, order_item_id)
);
create index michaels_order_lines_order_idx on public.michaels_order_lines (tenant_id, order_id);

-- Heads-ups already posted into Messages, by key, so each is said once.
create table public.michaels_alerts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  key text not null check (char_length(key) between 1 and 300),
  created_at timestamptz not null default now(),
  unique (tenant_id, key)
);

do $$
declare
  t text;
begin
  foreach t in array array['michaels_runs', 'michaels_listings', 'michaels_pairings',
                           'michaels_orders', 'michaels_order_lines', 'michaels_alerts']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy "members read their %s" on public.%I for select to authenticated
         using (tenant_id in (select private.user_tenant_ids()))', t, t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on public.%I to service_role', t);
  end loop;
  -- The whole team can look. Nobody writes except through the functions below.
  foreach t in array array['michaels_runs', 'michaels_listings', 'michaels_pairings',
                           'michaels_orders', 'michaels_order_lines']
  loop
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- The switches and the safety stop
-- ---------------------------------------------------------------------------

-- Is the connector on for a workspace: connected, and switched on in its
-- settings (configs: michaels / settings)?
create function private.michaels_on(p_tenant_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.connections c
    where c.tenant_id = p_tenant_id and c.provider = 'michaels' and c.status = 'active')
  and exists (
    select 1 from public.configs c
    where c.tenant_id = p_tenant_id and c.module = 'michaels' and c.key = 'settings'
      and c.body -> 'enabled' = 'true'::jsonb);
$$;
revoke all on function private.michaels_on(uuid) from public;

-- Why nothing may be sent to Michaels for a workspace. Worked out from the
-- listings themselves, every time it is asked:
--   no_scan    there are no listings to go by yet
--   unmatched  more than a tenth of the listings have no item: a SKU format
--              we don't understand, and selling on bad matches is worse than
--              waiting
--   watch_only this stage only watches
-- It never answers null ("free to send") in this stage. The stage that can
-- send replaces the last line with what the workspace's switches say, and
-- every send it builds must ask here first.
create function public.michaels_send_blocked(p_tenant_id uuid)
returns text
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_total int;
  v_unmatched int;
begin
  select count(*), count(*) filter (where l.stock_item_id is null)
  into v_total, v_unmatched
  from public.michaels_listings l where l.tenant_id = p_tenant_id;
  if v_total = 0 then
    return 'no_scan';
  end if;
  if v_unmatched * 10 > v_total then
    return 'unmatched';
  end if;
  return 'watch_only';
end;
$$;

-- ---------------------------------------------------------------------------
-- What managers do
-- ---------------------------------------------------------------------------

-- "Look now": asks for a look at the worker's next turn. A second press
-- while one is waiting or underway finds the first. Not more than one every
-- ten minutes, so a row of presses can't become a row of reads of Michaels.
create function public.request_michaels_run(p_tenant_id uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_manager(p_tenant_id);
  if not private.michaels_on(p_tenant_id) then
    raise exception 'not_on' using errcode = 'P0001';
  end if;
  select r.id into v_id from public.michaels_runs r
  where r.tenant_id = p_tenant_id and r.status in ('queued', 'running');
  if found then
    return v_id;
  end if;
  if exists (
    select 1 from public.michaels_runs r
    where r.tenant_id = p_tenant_id and r.created_at > now() - interval '10 minutes'
  ) then
    raise exception 'too_soon' using errcode = 'P0001';
  end if;
  begin
    insert into public.michaels_runs (tenant_id, source, requested_by)
    values (p_tenant_id, 'manual', auth.uid())
    returning id into v_id;
  exception when unique_violation then
    -- Two presses at once: the index lets one in, and this one finds it.
    select r.id into v_id from public.michaels_runs r
    where r.tenant_id = p_tenant_id and r.status in ('queued', 'running');
  end;
  return v_id;
end;
$$;

-- Pairs a Michaels seller SKU with the one item in the shop that has
-- `p_shop_sku` (exactly; else with capitals and outer spaces ignored). The
-- pairing wins over the matching rules from now on, and the listing is
-- matched straight away. Returns the item's id.
create function public.set_michaels_pairing(p_tenant_id uuid, p_seller_sku text, p_shop_sku text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  perform private.require_manager(p_tenant_id);
  if p_seller_sku is null or btrim(p_seller_sku) = '' or char_length(p_seller_sku) > 200
     or p_shop_sku is null or btrim(p_shop_sku) = '' or char_length(p_shop_sku) > 200 then
    raise exception 'no_item' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.michaels_listings l
    where l.tenant_id = p_tenant_id and l.seller_sku = p_seller_sku
  ) then
    raise exception 'no_listing' using errcode = 'P0001';
  end if;
  select array_agg(s.id) into v_ids from public.stock_items s
  where s.tenant_id = p_tenant_id and s.sku = p_shop_sku;
  if v_ids is null then
    select array_agg(s.id) into v_ids from public.stock_items s
    where s.tenant_id = p_tenant_id and lower(btrim(s.sku)) = lower(btrim(p_shop_sku));
  end if;
  if v_ids is null then
    raise exception 'no_item' using errcode = 'P0001';
  end if;
  if cardinality(v_ids) > 1 then
    raise exception 'many_items' using errcode = 'P0001';
  end if;

  insert into public.michaels_pairings (tenant_id, seller_sku, stock_item_id, created_by)
  values (p_tenant_id, p_seller_sku, v_ids[1], auth.uid())
  on conflict (tenant_id, seller_sku) do update
    set stock_item_id = excluded.stock_item_id, created_by = excluded.created_by, created_at = now();

  -- A seller SKU that is on Michaels twice stays reported as that.
  update public.michaels_listings l
  set stock_item_id = v_ids[1], matched_by = 'hand', problem = null, problem_detail = null
  where l.tenant_id = p_tenant_id and l.seller_sku = p_seller_sku
    and l.problem is distinct from 'duplicate';

  perform private.log_audit(p_tenant_id, 'michaels.paired', 'michaels_listing', left(p_seller_sku, 200));
  return v_ids[1];
end;
$$;

-- Takes a hand pairing off. The listing goes back to unmatched until the next
-- look matches it by the rules (or doesn't).
create function public.remove_michaels_pairing(p_tenant_id uuid, p_seller_sku text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_manager(p_tenant_id);
  delete from public.michaels_pairings p
  where p.tenant_id = p_tenant_id and p.seller_sku = p_seller_sku;
  if not found then
    return;
  end if;
  update public.michaels_listings l
  set stock_item_id = null, matched_by = null, problem = 'no_match',
      problem_detail = 'The pairing was taken off. It will be matched again at the next look.'
  where l.tenant_id = p_tenant_id and l.seller_sku = p_seller_sku and l.matched_by = 'hand';
  perform private.log_audit(p_tenant_id, 'michaels.unpaired', 'michaels_listing', left(p_seller_sku, 200));
end;
$$;

-- ---------------------------------------------------------------------------
-- The worker (service role)
-- ---------------------------------------------------------------------------

-- Hands out looks, one worker each. First tidies up: a look claimed over
-- thirty minutes ago never finished and is marked failed (not retried), and a
-- look still waiting for a workspace that has since switched off is closed.
-- Then forgets looks older than sixty days, queues a look for every workspace
-- that is switched on and hasn't had one in the last hour, and claims what is
-- waiting.
create function public.claim_michaels_runs(p_limit int default 5)
returns table (id uuid, tenant_id uuid, source text)
language plpgsql security definer set search_path = ''
as $$
begin
  update public.michaels_runs r
  set status = 'failed', finished_at = now(), error = 'This look never finished.',
      send_blocked = public.michaels_send_blocked(r.tenant_id)
  where r.status = 'running' and r.started_at < now() - interval '30 minutes';

  update public.michaels_runs r
  set status = 'failed', finished_at = now(),
      error = 'Michaels was switched off or disconnected before this look ran.',
      send_blocked = public.michaels_send_blocked(r.tenant_id)
  where r.status = 'queued' and not private.michaels_on(r.tenant_id);

  -- Looks are kept for sixty days; the listings and orders they left stay.
  delete from public.michaels_runs r
  where r.status in ('done', 'failed') and r.created_at < now() - interval '60 days';

  insert into public.michaels_runs (tenant_id, source)
  select c.tenant_id, 'schedule'
  from public.connections c
  where c.provider = 'michaels' and c.status = 'active' and private.michaels_on(c.tenant_id)
    and not exists (
      select 1 from public.michaels_runs r
      where r.tenant_id = c.tenant_id
        and (r.status in ('queued', 'running') or r.created_at > now() - interval '1 hour'))
  on conflict do nothing;

  return query
  with due as (
    select r.id from public.michaels_runs r
    where r.status = 'queued'
    order by r.created_at
    limit greatest(1, least(coalesce(p_limit, 5), 20))
    for update skip locked
  )
  update public.michaels_runs r set status = 'running', started_at = now()
  from due where r.id = due.id
  returning r.id, r.tenant_id, r.source;
end;
$$;

-- The listings one look read, with the match the worker worked out:
--   [{"michaels_sku_number", "primary_sku_number", "seller_sku", "item_name",
--     "listing_status", "gtin", "stock_item_id", "matched_by", "problem",
--     "problem_detail", "michaels_qty", "michaels_price",
--     "michaels_updated_at"}, ...]
-- An item that isn't this workspace's is no match. A figure Michaels didn't
-- give this time leaves what was known. Returns how many rows were written.
create function public.record_michaels_listings(p_tenant_id uuid, p_run_id uuid, p_rows jsonb)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  if not exists (
    select 1 from public.michaels_runs r
    where r.id = p_run_id and r.tenant_id = p_tenant_id and r.status = 'running'
  ) then
    raise exception 'That look is not underway' using errcode = 'P0002';
  end if;
  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) > 2000 then
    raise exception 'Bad rows' using errcode = '22023';
  end if;

  insert into public.michaels_listings as l
    (tenant_id, michaels_sku_number, primary_sku_number, seller_sku, item_name, listing_status,
     gtin, stock_item_id, matched_by, problem, problem_detail, michaels_qty, michaels_price,
     figures_at, michaels_updated_at, last_run_id, last_seen_at)
  select p_tenant_id, i.michaels_sku_number,
         coalesce(nullif(btrim(i.primary_sku_number), ''), i.michaels_sku_number),
         case when btrim(coalesce(i.seller_sku, '')) = '' then null else i.seller_sku end,
         left(nullif(btrim(i.item_name), ''), 300),
         left(nullif(btrim(i.listing_status), ''), 40),
         left(nullif(btrim(i.gtin), ''), 40),
         s.id,
         case when s.id is not null and i.matched_by in ('hand', 'exact', 'case', 'barcode')
              then i.matched_by
              when s.id is not null then 'exact' end,
         case when s.id is not null then null
              when i.problem in ('no_match', 'ambiguous', 'duplicate', 'no_seller_sku', 'pairing_missing')
              then i.problem
              else 'no_match' end,
         case when s.id is null then left(nullif(btrim(i.problem_detail), ''), 300) end,
         i.michaels_qty, round(i.michaels_price, 2),
         case when i.michaels_qty is not null or i.michaels_price is not null then now() end,
         i.michaels_updated_at, p_run_id, now()
  from (
    select distinct on (r.michaels_sku_number) r.*
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as r(
      michaels_sku_number text, primary_sku_number text, seller_sku text, item_name text,
      listing_status text, gtin text, stock_item_id uuid, matched_by text, problem text,
      problem_detail text, michaels_qty int, michaels_price numeric,
      michaels_updated_at timestamptz)
    where r.michaels_sku_number is not null
      and char_length(r.michaels_sku_number) between 1 and 80
      and char_length(coalesce(r.primary_sku_number, '')) <= 80
      and char_length(coalesce(r.seller_sku, '')) <= 200
    order by r.michaels_sku_number
  ) i
  left join public.stock_items s on s.id = i.stock_item_id and s.tenant_id = p_tenant_id
  on conflict (tenant_id, michaels_sku_number) do update set
    primary_sku_number = excluded.primary_sku_number,
    seller_sku = excluded.seller_sku,
    item_name = excluded.item_name,
    listing_status = excluded.listing_status,
    gtin = excluded.gtin,
    stock_item_id = excluded.stock_item_id,
    matched_by = excluded.matched_by,
    problem = excluded.problem,
    problem_detail = excluded.problem_detail,
    michaels_qty = coalesce(excluded.michaels_qty, l.michaels_qty),
    michaels_price = coalesce(excluded.michaels_price, l.michaels_price),
    figures_at = coalesce(excluded.figures_at, l.figures_at),
    michaels_updated_at = excluded.michaels_updated_at,
    last_run_id = excluded.last_run_id,
    last_seen_at = excluded.last_seen_at;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- After a complete read of the catalog: listings this look didn't see are no
-- longer on Michaels, and go. Returns how many went.
create function public.prune_michaels_listings(p_tenant_id uuid, p_run_id uuid)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  if not exists (
    select 1 from public.michaels_runs r
    where r.id = p_run_id and r.tenant_id = p_tenant_id and r.status = 'running'
  ) then
    raise exception 'That look is not underway' using errcode = 'P0002';
  end if;
  delete from public.michaels_listings l
  where l.tenant_id = p_tenant_id and l.last_run_id is distinct from p_run_id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- The orders one look read:
--   [{"order_number", "status", "currency", "placed_at", "promise_ship_at",
--     "michaels_updated_at", "items_subtotal", "shipping", "tax", "discount",
--     "grand_total", "lines": [{"order_item_id", "seller_sku",
--     "michaels_sku_number", "product_name", "quantity", "unit_price",
--     "line_status"}]}, ...]
-- Each is kept as observed; there is no way to record one as anything else.
-- Returns how many orders were written.
create function public.record_michaels_orders(p_tenant_id uuid, p_run_id uuid, p_orders jsonb)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  r record;
  v_order_id uuid;
  v_count int := 0;
begin
  if not exists (
    select 1 from public.michaels_runs m
    where m.id = p_run_id and m.tenant_id = p_tenant_id and m.status = 'running'
  ) then
    raise exception 'That look is not underway' using errcode = 'P0002';
  end if;
  if jsonb_typeof(coalesce(p_orders, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_orders, '[]'::jsonb)) > 2000 then
    raise exception 'Bad orders' using errcode = '22023';
  end if;

  for r in
    select o.* from jsonb_to_recordset(coalesce(p_orders, '[]'::jsonb)) as o(
      order_number text, status text, currency text, placed_at timestamptz,
      promise_ship_at timestamptz, michaels_updated_at timestamptz, items_subtotal numeric,
      shipping numeric, tax numeric, discount numeric, grand_total numeric, lines jsonb)
    where o.order_number is not null and char_length(o.order_number) between 1 and 80
  loop
    insert into public.michaels_orders as o
      (tenant_id, order_number, status, currency, placed_at, promise_ship_at, michaels_updated_at,
       items_subtotal, shipping, tax, discount, grand_total, last_seen_at)
    values
      (p_tenant_id, r.order_number, left(coalesce(nullif(btrim(r.status), ''), 'UNKNOWN'), 40),
       left(nullif(btrim(r.currency), ''), 8), r.placed_at, r.promise_ship_at,
       r.michaels_updated_at, round(r.items_subtotal, 2), round(r.shipping, 2), round(r.tax, 2),
       round(r.discount, 2), round(r.grand_total, 2), now())
    on conflict (tenant_id, order_number) do update set
      status = excluded.status, currency = excluded.currency,
      placed_at = coalesce(excluded.placed_at, o.placed_at),
      promise_ship_at = excluded.promise_ship_at,
      michaels_updated_at = excluded.michaels_updated_at,
      items_subtotal = excluded.items_subtotal, shipping = excluded.shipping,
      tax = excluded.tax, discount = excluded.discount, grand_total = excluded.grand_total,
      last_seen_at = excluded.last_seen_at
    returning o.id into v_order_id;

    if jsonb_typeof(coalesce(r.lines, '[]'::jsonb)) = 'array' then
      delete from public.michaels_order_lines l
      where l.tenant_id = p_tenant_id and l.order_id = v_order_id
        and l.order_item_id not in (
          select i.order_item_id
          from jsonb_to_recordset(coalesce(r.lines, '[]'::jsonb)) as i(order_item_id text)
          where i.order_item_id is not null);
      insert into public.michaels_order_lines as l
        (tenant_id, order_id, order_item_id, seller_sku, michaels_sku_number, product_name,
         quantity, unit_price, line_status)
      select p_tenant_id, v_order_id, i.order_item_id, left(i.seller_sku, 200),
             left(i.michaels_sku_number, 80), left(i.product_name, 300),
             greatest(0, least(coalesce(i.quantity, 0), 1000000)), round(i.unit_price, 2),
             left(i.line_status, 40)
      from (
        select distinct on (x.order_item_id) x.*
        from jsonb_to_recordset(coalesce(r.lines, '[]'::jsonb)) as x(
          order_item_id text, seller_sku text, michaels_sku_number text, product_name text,
          quantity int, unit_price numeric, line_status text)
        where x.order_item_id is not null and char_length(x.order_item_id) between 1 and 80
        order by x.order_item_id
      ) i
      on conflict (tenant_id, order_item_id) do update set
        order_id = excluded.order_id, seller_sku = excluded.seller_sku,
        michaels_sku_number = excluded.michaels_sku_number,
        product_name = excluded.product_name, quantity = excluded.quantity,
        unit_price = excluded.unit_price, line_status = excluded.line_status;
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Closes a look: what it counted, what it would have sent, and how it ended.
-- The reason nothing could be sent is worked out here, from the listings, and
-- not taken from the worker. Returns that reason and how many looks in a row
-- have now failed: {"send_blocked", "failed_in_row"}.
create function public.finish_michaels_run(
  p_run_id uuid, p_status text, p_counts jsonb, p_changes jsonb, p_error text
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_run public.michaels_runs;
  v_blocked text;
  v_failed int;
  v_changes jsonb;
begin
  if p_status is null or p_status not in ('done', 'failed') then
    raise exception 'Unknown status' using errcode = '22023';
  end if;
  select * into v_run from public.michaels_runs r
  where r.id = p_run_id and r.status = 'running' for update;
  if not found then
    raise exception 'That look is not underway' using errcode = 'P0002';
  end if;
  v_blocked := public.michaels_send_blocked(v_run.tenant_id);
  if v_blocked is null then
    -- Belt and braces: this stage has no other answer.
    v_blocked := 'watch_only';
  end if;
  select coalesce(jsonb_agg(e.value order by e.ordinality), '[]'::jsonb) into v_changes
  from jsonb_array_elements(
    case when jsonb_typeof(p_changes) = 'array' then p_changes else '[]'::jsonb end
  ) with ordinality as e(value, ordinality)
  where e.ordinality <= 500 and jsonb_typeof(e.value) = 'object';

  update public.michaels_runs r
  set status = p_status, finished_at = now(),
      counts = case when jsonb_typeof(p_counts) = 'object' then p_counts else '{}'::jsonb end,
      changes = v_changes, send_blocked = v_blocked,
      error = left(nullif(btrim(p_error), ''), 1000)
  where r.id = v_run.id;

  select count(*) into v_failed from public.michaels_runs r
  where r.tenant_id = v_run.tenant_id and r.status = 'failed'
    and r.created_at > coalesce(
      (select max(d.created_at) from public.michaels_runs d
       where d.tenant_id = v_run.tenant_id and d.status = 'done'),
      '-infinity'::timestamptz);
  return jsonb_build_object('send_blocked', v_blocked, 'failed_in_row', v_failed);
end;
$$;

-- Notes that a heads-up is about to be posted. True the first time a key is
-- seen for a workspace; false after that, so each is said once.
create function public.note_michaels_alert(p_tenant_id uuid, p_key text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  if p_key is null or btrim(p_key) = '' then
    return false;
  end if;
  insert into public.michaels_alerts (tenant_id, key)
  values (p_tenant_id, left(p_key, 300))
  on conflict (tenant_id, key) do nothing;
  return found;
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.michaels_send_blocked(uuid)',
    'public.claim_michaels_runs(int)',
    'public.record_michaels_listings(uuid, uuid, jsonb)',
    'public.prune_michaels_listings(uuid, uuid)',
    'public.record_michaels_orders(uuid, uuid, jsonb)',
    'public.finish_michaels_run(uuid, text, jsonb, jsonb, text)',
    'public.note_michaels_alert(uuid, text)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
  foreach fn in array array[
    'public.request_michaels_run(uuid)',
    'public.set_michaels_pairing(uuid, text, text)',
    'public.remove_michaels_pairing(uuid, text)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;
