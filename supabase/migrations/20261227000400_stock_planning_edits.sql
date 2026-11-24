-- Planning figures changed in the table, one box at a time or for every
-- ticked item at once.
--
-- The first migration's `plan_stock_items` writes every planning column on
-- every item it is given, so it can't be used for "set the case size on these
-- twenty": it would wipe their lead times and suppliers. It is left as it is
-- (no screen calls it); this one changes only the figures it is handed.

-- p_changes is an object holding only what should change, for example
--   {"lead_time_days": 21}            set it
--   {"moq": null, "case_pack": null}  clear them (back to the supplier's / single units)
-- Keys: lead_time_days, coverage_days, safety_stock, moq, case_pack,
-- own_cost, and supplier_sku (one item at a time: a code names one thing).
-- A key that isn't there is left alone. Returns how many items were changed.
create function public.set_stock_items_planning(
  p_tenant_id uuid, p_item_ids uuid[], p_changes jsonb
)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
  v_lead int;
  v_cover int;
  v_spare int;
  v_moq int;
  v_case int;
  v_cost numeric;
begin
  perform private.require_manager(p_tenant_id);
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then
    raise exception 'Nothing to change' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_changes) as k
    where k not in ('lead_time_days', 'coverage_days', 'safety_stock', 'moq', 'case_pack',
                    'own_cost', 'supplier_sku')
  ) then
    raise exception 'That isn''t a planning figure' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_each(p_changes) as e
    where (e.key = 'supplier_sku' and jsonb_typeof(e.value) not in ('string', 'null'))
       or (e.key <> 'supplier_sku' and jsonb_typeof(e.value) not in ('number', 'null'))
  ) then
    raise exception 'That figure is not valid' using errcode = '22023';
  end if;
  if p_changes ? 'supplier_sku' and coalesce(cardinality(p_item_ids), 0) <> 1 then
    raise exception 'A supplier''s code is set one item at a time' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_each_text(p_changes) as e
    where e.key not in ('own_cost', 'supplier_sku') and e.value is not null
      and e.value !~ '^\d{1,7}$'
  ) then
    raise exception 'That figure is not valid' using errcode = '22023';
  end if;

  v_lead := (p_changes ->> 'lead_time_days')::int;
  v_cover := (p_changes ->> 'coverage_days')::int;
  v_spare := coalesce((p_changes ->> 'safety_stock')::int, 0);
  v_moq := (p_changes ->> 'moq')::int;
  v_case := (p_changes ->> 'case_pack')::int;
  v_cost := round((p_changes ->> 'own_cost')::numeric, 2);
  if v_lead not between 0 and 365 or v_cover not between 1 and 365
     or v_spare not between 0 and 1000000 or v_moq not between 1 and 1000000
     or v_case not between 1 and 100000 or v_cost not between 0 and 100000000 then
    raise exception 'That figure is not valid' using errcode = '22023';
  end if;
  -- A case of one is just single units.
  if v_case = 1 then
    v_case := null;
  end if;

  update public.stock_items si
  set lead_time_days = case when p_changes ? 'lead_time_days' then v_lead else si.lead_time_days end,
      coverage_days = case when p_changes ? 'coverage_days' then v_cover else si.coverage_days end,
      safety_stock = case when p_changes ? 'safety_stock' then v_spare else si.safety_stock end,
      moq = case when p_changes ? 'moq' then v_moq else si.moq end,
      case_pack = case when p_changes ? 'case_pack' then v_case else si.case_pack end,
      own_cost = case when p_changes ? 'own_cost' then v_cost else si.own_cost end,
      supplier_sku = case when p_changes ? 'supplier_sku'
        then nullif(left(btrim(coalesce(p_changes ->> 'supplier_sku', '')), 120), '')
        else si.supplier_sku end
  where si.tenant_id = p_tenant_id and si.id = any (coalesce(p_item_ids, '{}'));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.set_stock_items_planning(uuid, uuid[], jsonb) from public, anon;
grant execute on function public.set_stock_items_planning(uuid, uuid[], jsonb) to authenticated;
