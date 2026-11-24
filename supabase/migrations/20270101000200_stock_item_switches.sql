-- Items and suppliers, the last of what TuftStock's Inventory and Suppliers
-- screens do that the suite did not:
--
--   * "Don't reorder" apart from "Hidden". Hidden (the existing `hidden`
--     column) puts an item out of sight and out of planning. Don't reorder
--     only stops the suggestions: the item stays in the list with its count.
--   * The shop's tags on each item, so a workspace can say "never reorder
--     anything tagged X" (the rule itself is a setting, applied on read).
--   * A supplier whose days-to-arrive is left empty follows the workspace's
--     own default, and one press adopts how long they really take.

alter table public.stock_items
  add column dont_reorder boolean not null default false,
  -- The product's tags in the shop, written only by the sync.
  add column tags text[] not null default '{}'
    check (cardinality(tags) <= 100);

-- Stops (or restarts) suggestions for some items, leaving them in the list.
-- Owners and admins only. Returns how many items changed.
create function public.set_stock_items_reorder(
  p_tenant_id uuid, p_item_ids uuid[], p_dont_reorder boolean
)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  perform private.require_manager(p_tenant_id);
  update public.stock_items si
  set dont_reorder = coalesce(p_dont_reorder, false)
  where si.tenant_id = p_tenant_id and si.id = any (coalesce(p_item_ids, '{}'))
    and si.dont_reorder is distinct from coalesce(p_dont_reorder, false);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.set_stock_items_reorder(uuid, uuid[], boolean) from public, anon;
grant execute on function public.set_stock_items_reorder(uuid, uuid[], boolean) to authenticated;

-- Notes each product's tags on its items: [{"product_external_id", "tags": [..]}].
-- Written only by the sync (service role), for one named workspace. Tags are
-- kept as the shop spells them, trimmed, at most 100 of 80 characters each.
create function public.set_stock_item_tags(p_tenant_id uuid, p_provider text, p_items jsonb)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  update public.stock_items si
  set tags = t.tags
  from (
    select i.product_external_id,
           coalesce((
             select array_agg(distinct x.tag order by x.tag)
             from (
               select left(btrim(v.value), 80) as tag
               from jsonb_array_elements_text(
                      case when jsonb_typeof(i.tags) = 'array' then i.tags else '[]'::jsonb end
                    ) as v(value)
               where btrim(v.value) <> ''
               limit 100
             ) x
           ), '{}') as tags
    from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as i(
      product_external_id text, tags jsonb)
    where i.product_external_id is not null
  ) t
  where si.tenant_id = p_tenant_id and si.provider = p_provider
    and si.product_external_id = t.product_external_id
    and si.tags is distinct from t.tags;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.set_stock_item_tags(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.set_stock_item_tags(uuid, text, jsonb) to service_role;

-- A supplier's days-to-arrive may be left empty: its items then follow the
-- workspace's own default (Stock → Settings), as in TuftStock. Suppliers that
-- already have a figure keep it.
alter table public.suppliers
  alter column lead_time_days drop not null,
  alter column lead_time_days drop default;

-- Sets one supplier's days-to-arrive, or empties it (null) to follow the
-- workspace's default. This is what "use the days they really take" presses.
create function public.set_supplier_lead_time(p_tenant_id uuid, p_supplier_id uuid, p_days int)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_manager(p_tenant_id);
  if p_days is not null and p_days not between 0 and 365 then
    raise exception 'Bad lead time' using errcode = '22023';
  end if;
  update public.suppliers s set lead_time_days = p_days
  where s.id = p_supplier_id and s.tenant_id = p_tenant_id;
  if not found then
    raise exception 'Supplier not found' using errcode = 'P0002';
  end if;
end;
$$;
revoke all on function public.set_supplier_lead_time(uuid, uuid, int) from public, anon;
grant execute on function public.set_supplier_lead_time(uuid, uuid, int) to authenticated;

-- The supplier import, as it was, with one comparison changed: now that a
-- supplier's days-to-arrive can be empty, "is the file's figure different?"
-- has to be asked with `is distinct from`, or a figure for a supplier that
-- has none would be passed over.
create or replace function public.import_suppliers(
  p_tenant_id uuid, p_request_key uuid, p_rows jsonb, p_file_name text default '',
  p_confirm boolean default false
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_done jsonb := private.import_begin(p_tenant_id, p_request_key, p_rows, p_confirm);
  v_new int := 0;
  v_changed int := 0;
  v_same int := 0;
  v_counts jsonb;
  e jsonb;
  v_id uuid;
  v_name text;
  v_emails text[];
  v_n int;
begin
  if v_done is not null then
    return v_done;
  end if;
  begin
    for e in select * from jsonb_array_elements(p_rows)
    loop
      v_name := left(btrim(coalesce(e ->> 'name', '')), 120);
      if v_name = '' then
        raise exception 'A supplier needs a name' using errcode = '22023';
      end if;
      v_emails := null;
      if e ? 'emails' then
        select coalesce(array_agg(x.email order by x.ord), '{}') into v_emails
        from (
          select lower(btrim(t.value)) as email, min(t.ord) as ord
          from jsonb_array_elements_text(
                 case when jsonb_typeof(e -> 'emails') = 'array' then e -> 'emails'
                      else '[]'::jsonb end) with ordinality as t(value, ord)
          where btrim(t.value) <> ''
          group by 1
        ) x;
        if cardinality(v_emails) > 6 or exists (
          select 1 from unnest(v_emails) as m
          where char_length(m) > 200 or m !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
        ) then
          raise exception 'Bad email' using errcode = '22023';
        end if;
      end if;

      select s.id into v_id from public.suppliers s
      where s.tenant_id = p_tenant_id and lower(s.name) = lower(v_name)
      order by (s.name = v_name) desc, s.created_at limit 1;
      if v_id is null then
        insert into public.suppliers (tenant_id, name) values (p_tenant_id, v_name)
        returning id into v_id;
        v_new := v_new + 1;
        v_n := 0;
      else
        v_n := 1;
      end if;

      update public.suppliers s
      set contact_name = case when e ? 'contact_name'
            then nullif(left(btrim(coalesce(e ->> 'contact_name', '')), 120), '')
            else s.contact_name end,
          email = case when e ? 'emails' then v_emails[1] else s.email end,
          more_emails = case when e ? 'emails' then coalesce(v_emails[2:], '{}')
            else s.more_emails end,
          lead_time_days = coalesce((e ->> 'lead_time_days')::int, s.lead_time_days),
          coverage_days = coalesce((e ->> 'coverage_days')::int, s.coverage_days),
          moq = coalesce((e ->> 'moq')::int, s.moq),
          moq_applies_to = coalesce(nullif(lower(e ->> 'moq_applies_to'), ''), s.moq_applies_to),
          payment_terms_days = coalesce((e ->> 'payment_terms_days')::int, s.payment_terms_days),
          notes = case when e ? 'notes' then left(coalesce(e ->> 'notes', ''), 2000) else s.notes end,
          archived_at = case
            when not (e ? 'archived') or e ->> 'archived' is null then s.archived_at
            when (e ->> 'archived')::boolean then coalesce(s.archived_at, now())
            else null end
      where s.id = v_id
        and (
          (e ? 'contact_name' and s.contact_name is distinct from
             nullif(left(btrim(coalesce(e ->> 'contact_name', '')), 120), ''))
          or (e ? 'emails' and (s.email is distinct from v_emails[1]
             or s.more_emails is distinct from coalesce(v_emails[2:], '{}')))
          or coalesce((e ->> 'lead_time_days')::int, s.lead_time_days)
               is distinct from s.lead_time_days
          or coalesce((e ->> 'coverage_days')::int, s.coverage_days) <> s.coverage_days
          or coalesce((e ->> 'moq')::int, s.moq) <> s.moq
          or coalesce(nullif(lower(e ->> 'moq_applies_to'), ''), s.moq_applies_to) <> s.moq_applies_to
          or coalesce((e ->> 'payment_terms_days')::int, s.payment_terms_days) <> s.payment_terms_days
          or (e ? 'notes' and s.notes <> left(coalesce(e ->> 'notes', ''), 2000))
          or (e ? 'archived' and e ->> 'archived' is not null
              and (e ->> 'archived')::boolean <> (s.archived_at is not null))
        );
      if v_n = 1 then
        if found then v_changed := v_changed + 1; else v_same := v_same + 1; end if;
      end if;
    end loop;
    v_counts := jsonb_build_object('new', v_new, 'changed', v_changed, 'same', v_same);
    if not coalesce(p_confirm, false) then
      -- Only a look: undo everything this block did.
      raise exception 'look' using errcode = 'IMPLK';
    end if;
  exception when sqlstate 'IMPLK' then
    return v_counts || jsonb_build_object('repeated', false);
  end;
  return private.import_end(p_tenant_id, p_request_key, 'suppliers', p_file_name, v_counts);
end;
$$;
