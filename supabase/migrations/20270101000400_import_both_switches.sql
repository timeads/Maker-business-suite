-- The item planning import, as it was, now carrying both of an item's
-- switches. Before there was one ("hidden"), and a file's "don't reorder"
-- column was folded into it. Now that "don't reorder" (still listed, never
-- suggested) is its own switch, a file can set each on its own:
--
-- [{"stock_item_id", "supplier", "supplier_sku", "own_cost", "lead_time_days",
--   "coverage_days", "safety_stock", "moq", "case_pack", "hidden",
--   "dont_reorder"}, ...]
--
-- Everything else is unchanged: a key in a row is set, one that isn't is
-- left alone, and the same file again changes nothing.
create or replace function public.import_item_planning(
  p_tenant_id uuid, p_request_key uuid, p_rows jsonb, p_file_name text default '',
  p_confirm boolean default false
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_done jsonb := private.import_begin(p_tenant_id, p_request_key, p_rows, p_confirm);
  v_changed int := 0;
  v_same int := 0;
  v_suppliers int := 0;
  v_counts jsonb;
  e jsonb;
  v_item uuid;
  v_supplier uuid;
  v_case int;
begin
  if v_done is not null then
    return v_done;
  end if;
  begin
    for e in select * from jsonb_array_elements(p_rows)
    loop
      select si.id into v_item from public.stock_items si
      where si.id = (e ->> 'stock_item_id')::uuid and si.tenant_id = p_tenant_id;
      if v_item is null then
        raise exception 'Item not found' using errcode = 'P0002';
      end if;
      v_supplier := null;
      if nullif(btrim(coalesce(e ->> 'supplier', '')), '') is not null then
        select s.p_added, s.p_id into v_suppliers, v_supplier
        from private.import_supplier(p_tenant_id, e ->> 'supplier', v_suppliers) s;
      end if;
      -- A case of one is just single units.
      v_case := nullif((e ->> 'case_pack')::int, 1);

      update public.stock_items si
      set supplier_id = coalesce(v_supplier, si.supplier_id),
          supplier_sku = case when e ? 'supplier_sku'
            then nullif(left(btrim(coalesce(e ->> 'supplier_sku', '')), 120), '')
            else si.supplier_sku end,
          own_cost = case when e ? 'own_cost' then round((e ->> 'own_cost')::numeric, 2)
            else si.own_cost end,
          lead_time_days = case when e ? 'lead_time_days' then (e ->> 'lead_time_days')::int
            else si.lead_time_days end,
          coverage_days = case when e ? 'coverage_days' then (e ->> 'coverage_days')::int
            else si.coverage_days end,
          safety_stock = case when e ? 'safety_stock' then coalesce((e ->> 'safety_stock')::int, 0)
            else si.safety_stock end,
          moq = case when e ? 'moq' then (e ->> 'moq')::int else si.moq end,
          case_pack = case when e ? 'case_pack' then v_case else si.case_pack end,
          hidden = case when e ? 'hidden' then coalesce((e ->> 'hidden')::boolean, false)
            else si.hidden end,
          dont_reorder = case when e ? 'dont_reorder'
            then coalesce((e ->> 'dont_reorder')::boolean, false)
            else si.dont_reorder end
      where si.id = v_item
        and (
          (v_supplier is not null and si.supplier_id is distinct from v_supplier)
          or (e ? 'supplier_sku' and si.supplier_sku is distinct from
              nullif(left(btrim(coalesce(e ->> 'supplier_sku', '')), 120), ''))
          or (e ? 'own_cost' and si.own_cost is distinct from round((e ->> 'own_cost')::numeric, 2))
          or (e ? 'lead_time_days' and si.lead_time_days is distinct from (e ->> 'lead_time_days')::int)
          or (e ? 'coverage_days' and si.coverage_days is distinct from (e ->> 'coverage_days')::int)
          or (e ? 'safety_stock' and si.safety_stock <> coalesce((e ->> 'safety_stock')::int, 0))
          or (e ? 'moq' and si.moq is distinct from (e ->> 'moq')::int)
          or (e ? 'case_pack' and si.case_pack is distinct from v_case)
          or (e ? 'hidden' and si.hidden <> coalesce((e ->> 'hidden')::boolean, false))
          or (e ? 'dont_reorder'
              and si.dont_reorder <> coalesce((e ->> 'dont_reorder')::boolean, false))
        );
      if found then v_changed := v_changed + 1; else v_same := v_same + 1; end if;
    end loop;
    v_counts := jsonb_build_object(
      'new', 0, 'changed', v_changed, 'same', v_same, 'suppliers_added', v_suppliers);
    if not coalesce(p_confirm, false) then
      raise exception 'look' using errcode = 'IMPLK';
    end if;
  exception when sqlstate 'IMPLK' then
    return v_counts || jsonb_build_object('repeated', false);
  end;
  return private.import_end(p_tenant_id, p_request_key, 'items', p_file_name, v_counts);
end;
$$;
