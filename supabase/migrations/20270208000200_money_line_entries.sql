-- Money: month-by-month entries for profit by line.
--
-- Two kinds, each for one calendar month:
-- - `cost`: what one of the monthly costs the books don't hold (rent split
--   between lines, help paid by the hour, an owner's pay; Settings → Money →
--   Profit by line) really came to that month, in place of its usual amount;
-- - `revenue`: revenue a line had that month that reached neither the shop
--   nor the books (sales through another shop, say), typed in by hand.
-- Only what a person typed is kept; profit is still worked out on read.
--
-- The whole team reads them, as it reads profit by line and the monthly
-- costs themselves; owners and admins write them, through one checked
-- function that knows the workspace's own costs and lines.

create table public.money_line_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  kind text not null check (kind in ('cost', 'revenue')),
  month date not null check (extract(day from month) = 1),
  -- A monthly cost's id (kind cost) or a business line's id (kind revenue).
  subject text not null check (subject ~ '^[a-z0-9-]{1,40}$'),
  amount_cents bigint not null check (amount_cents between 0 and 100000000000),
  note text check (char_length(note) <= 200),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (tenant_id, kind, month, subject)
);
create index money_line_entries_month_idx on public.money_line_entries (tenant_id, month);

alter table public.money_line_entries enable row level security;
create policy "members read their month entries" on public.money_line_entries
  for select to authenticated
  using (tenant_id in (select private.user_tenant_ids()));
revoke all on public.money_line_entries from public, anon, authenticated, service_role;
grant select on public.money_line_entries to authenticated, service_role;

-- The ids of the workspace's monthly costs (Settings → Money → Profit by line).
create function private.money_cost_ids(p_tenant_id uuid)
returns text[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(c ->> 'id'), '{}'::text[])
  from public.configs g,
       jsonb_array_elements(
         case when jsonb_typeof(g.body -> 'monthly_costs') = 'array' then g.body -> 'monthly_costs'
              else '[]'::jsonb end) c
  where g.tenant_id = p_tenant_id and g.module = 'dashboard' and g.key = 'profit';
$$;
revoke all on function private.money_cost_ids(uuid) from public;

-- Sets one month's entries: [{"kind", "subject", "amount_cents", "note"}];
-- an amount of null takes the entry away (back to the usual amount, or to
-- nothing typed in). Owners and admins. Returns how many rows it looked at.
create function public.set_money_line_entries(p_tenant_id uuid, p_month date, p_rows jsonb)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  r record;
  v_costs text[];
  v_lines text[];
  v_count int := 0;
begin
  perform private.require_manager(p_tenant_id);
  if p_month is null or extract(day from p_month) <> 1 then
    raise exception 'An entry is for a whole month' using errcode = '22023';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 100 then
    raise exception 'Send between 0 and 100 entries' using errcode = '22023';
  end if;
  v_costs := private.money_cost_ids(p_tenant_id);
  v_lines := private.money_line_ids(p_tenant_id);
  for r in
    select x.kind, x.subject, x.amount_cents, x.note
    from jsonb_to_recordset(p_rows) as x(kind text, subject text, amount_cents jsonb, note text)
  loop
    if r.kind = 'cost' and not (r.subject = any (v_costs)) then
      raise exception 'That isn''t one of your monthly costs' using errcode = '22023';
    end if;
    if r.kind = 'revenue' and not (r.subject = any (v_lines)) then
      raise exception 'That isn''t one of your lines' using errcode = '22023';
    end if;
    if r.kind is null or r.kind not in ('cost', 'revenue') then
      raise exception 'That isn''t a kind of entry' using errcode = '22023';
    end if;
    if r.amount_cents is null or jsonb_typeof(r.amount_cents) = 'null' then
      delete from public.money_line_entries e
      where e.tenant_id = p_tenant_id and e.kind = r.kind and e.month = p_month
        and e.subject = r.subject;
    else
      if jsonb_typeof(r.amount_cents) <> 'number'
         or (r.amount_cents #>> '{}') !~ '^[0-9]{1,12}$' then
        raise exception 'An amount is a whole number of cents, nothing below zero'
          using errcode = '22023';
      end if;
      insert into public.money_line_entries
        (tenant_id, kind, month, subject, amount_cents, note, updated_by, updated_at)
      values (p_tenant_id, r.kind, p_month, r.subject, (r.amount_cents #>> '{}')::bigint,
              nullif(left(btrim(coalesce(r.note, '')), 200), ''), auth.uid(), now())
      on conflict (tenant_id, kind, month, subject) do update
        set amount_cents = excluded.amount_cents, note = excluded.note,
            updated_by = excluded.updated_by, updated_at = now();
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.set_money_line_entries(uuid, date, jsonb) from public, anon;
grant execute on function public.set_money_line_entries(uuid, date, jsonb) to authenticated;
