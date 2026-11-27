-- Money: the monthly summary Claude writes from the business's own figures.
-- OWNERS AND ADMINS ONLY (it sums up the finances, debts included).
--
-- A person presses "Write this month's summary" on Money; the server works
-- out every figure, Claude only picks which to mention and words the
-- sentences around them, and code fills the figures in (`lib/dashboard/
-- summary.ts`). What is kept here is that finished text, one per workspace
-- per month, replaced by "Write it again". Nothing here is ever emailed or
-- sent anywhere.
--
-- Written only by `save_money_summary`, which the server calls with the
-- service role after the model's answer has been checked, naming the owner
-- or admin who pressed; nobody can type a summary in themselves, so "written
-- by AI from your figures" stays true. Read by owners and admins only, and
-- like every Money table also behind the "only people with Money" rule.

create table public.money_summaries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  -- The month it sums up (its first day).
  month date not null check (extract(day from month) = 1),
  -- [{"section": "month" | "review" | "cut",
  --   "points": [{"text": "…", "refs": ["F1", …]}]}]
  sections jsonb not null check (jsonb_typeof(sections) = 'array'),
  written_by uuid references auth.users (id) on delete set null,
  written_at timestamptz not null default now(),
  unique (tenant_id, month)
);

alter table public.money_summaries enable row level security;
create policy "owners and admins read their money_summaries" on public.money_summaries
  for select to authenticated
  using (private.has_tenant_role(tenant_id, array['owner', 'admin']::public.membership_role[]));
create policy "only people with Money read it" on public.money_summaries as restrictive
  for select to authenticated
  using (tenant_id in (select private.tool_tenant_ids(array['dashboard'])));
create trigger tool_write_guard before insert or update or delete on public.money_summaries
  for each row execute function private.tool_write_guard('dashboard');
revoke all on public.money_summaries from public, anon, authenticated, service_role;
grant select on public.money_summaries to authenticated, service_role;

-- Keeps a month's summary (a new one replaces the month's last). Service
-- role only: the server calls it once the model's answer has been checked.
-- p_written_by must be an owner or admin of the workspace. Returns the id.
create function public.save_money_summary(
  p_tenant_id uuid, p_month date, p_sections jsonb, p_written_by uuid
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  s jsonb;
  p jsonb;
  v_points int := 0;
begin
  if p_tenant_id is null or p_month is null or extract(day from p_month) <> 1 then
    raise exception 'Say which month' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.memberships m
    where m.tenant_id = p_tenant_id and m.user_id = p_written_by
      and m.role in ('owner', 'admin')
  ) then
    raise exception 'Only owners and admins can have a summary written' using errcode = '42501';
  end if;
  if p_sections is null or jsonb_typeof(p_sections) <> 'array'
     or jsonb_array_length(p_sections) not between 1 and 3
     or octet_length(p_sections::text) > 20000 then
    raise exception 'Send up to three sections' using errcode = '22023';
  end if;
  for s in select value from jsonb_array_elements(p_sections)
  loop
    if jsonb_typeof(s) <> 'object'
       or coalesce(s ->> 'section', '') not in ('month', 'review', 'cut')
       or jsonb_typeof(s -> 'points') is distinct from 'array'
       or jsonb_array_length(s -> 'points') > 6 then
      raise exception 'A section isn''t one a summary can have' using errcode = '22023';
    end if;
    for p in select value from jsonb_array_elements(s -> 'points')
    loop
      if jsonb_typeof(p) <> 'object' or jsonb_typeof(p -> 'text') is distinct from 'string'
         or char_length(p ->> 'text') not between 1 and 600 then
        raise exception 'A point isn''t one a summary can have' using errcode = '22023';
      end if;
      v_points := v_points + 1;
    end loop;
  end loop;
  if v_points = 0 then
    raise exception 'A summary needs something to say' using errcode = '22023';
  end if;

  insert into public.money_summaries (tenant_id, month, sections, written_by, written_at)
  values (p_tenant_id, p_month, p_sections, p_written_by, now())
  on conflict (tenant_id, month) do update
    set sections = excluded.sections, written_by = excluded.written_by,
        written_at = excluded.written_at
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.save_money_summary(uuid, date, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.save_money_summary(uuid, date, jsonb, uuid) to service_role;
