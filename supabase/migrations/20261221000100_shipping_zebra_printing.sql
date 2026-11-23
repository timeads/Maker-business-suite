-- Printing labels straight to a Zebra thermal printer.
--
-- Which printer a computer uses is that computer's own business and is kept
-- in its browser, not here. What the database holds is:
--
--   * a label's ZPL (the printer's own format) when it was bought from
--     EasyPost for a Zebra, so it can be printed again later. UPS and Redo
--     labels already keep their file through `mark_label_bought_from`; this
--     lets an EasyPost label do the same without changing how it is bought
--     or kept. The file lives in `shipping_label_files`, so the same
--     row-level security and the same blanking rules cover it.
--   * that a label has been printed, by whom and when, so another computer
--     can warn before a second copy of the same label comes out.

-- ---------------------------------------------------------------------------
-- A label has been printed
-- ---------------------------------------------------------------------------

alter table public.shipments
  add column label_printed_at timestamptz,
  add column label_printed_by uuid references auth.users (id) on delete set null,
  add column label_print_count int not null default 0 check (label_print_count >= 0);

-- Says a parcel's label went to a printer. Anyone on the team packs, so
-- anyone on the team may say so; the parcel must be one of their workspace's
-- and must have a bought label. An order that rode along on another's label
-- has none of its own: the mark goes on the parcel that carries the label.
create function public.mark_label_printed(p_shipment_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_shipment public.shipments;
begin
  select * into v_shipment from public.shipments s
  where s.id = p_shipment_id and s.tenant_id in (select private.user_tenant_ids())
  for update;
  if not found then
    raise exception 'Parcel not found' using errcode = 'P0002';
  end if;
  if v_shipment.merged_with is not null then
    select * into v_shipment from public.shipments s
    where s.id = v_shipment.merged_with and s.tenant_id = v_shipment.tenant_id
    for update;
    if not found then
      raise exception 'Parcel not found' using errcode = 'P0002';
    end if;
  end if;
  if v_shipment.label_provider is null then
    raise exception 'That parcel has no label' using errcode = 'P0001';
  end if;
  update public.shipments s
  set label_printed_at = now(), label_printed_by = auth.uid(),
      label_print_count = s.label_print_count + 1
  where s.id = v_shipment.id
  returning * into v_shipment;
  return jsonb_build_object(
    'shipment_id', v_shipment.id,
    'printed_at', v_shipment.label_printed_at,
    'count', v_shipment.label_print_count);
end;
$$;

-- ---------------------------------------------------------------------------
-- Keeping a bought label's file after the label itself is kept
-- ---------------------------------------------------------------------------

-- Adds label files to a label that is bought but not yet a parcel, and
-- points each box at its file. Written by the server with the service role,
-- straight after `mark_label_bought`. A file that can't be kept is left out:
-- the label is already safe, with its link.
--
-- `p_files`: [{"box", "content_type", "data"}], as for `mark_label_bought_from`.
create function public.keep_label_files(p_tenant_id uuid, p_quote_id uuid, p_files jsonb)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_quote public.shipping_label_quotes;
  v_parcels jsonb;
  v_file record;
  v_file_id uuid;
  v_kept int := 0;
begin
  select * into v_quote from public.shipping_label_quotes q
  where q.id = p_quote_id and q.tenant_id = p_tenant_id and q.status = 'bought'
  for update;
  if not found then
    return 0;
  end if;
  v_parcels := case when jsonb_typeof(v_quote.parcels) = 'array' then v_quote.parcels
                    else '[]'::jsonb end;

  for v_file in
    select (f.b ->> 'box')::int as box, f.b ->> 'content_type' as content_type, f.b ->> 'data' as data
    from jsonb_array_elements(
           case when jsonb_typeof(p_files) = 'array' then p_files else '[]'::jsonb end) f(b)
    where jsonb_typeof(f.b) = 'object' and f.b ->> 'box' ~ '^[1-6]$'
  loop
    continue when v_file.box > jsonb_array_length(v_parcels);
    begin
      insert into public.shipping_label_files (tenant_id, quote_id, box, content_type, data)
      values (p_tenant_id, p_quote_id, v_file.box, v_file.content_type, v_file.data)
      on conflict (quote_id, box) do update
        set content_type = excluded.content_type, data = excluded.data
      returning id into v_file_id;
      v_parcels := jsonb_set(
        v_parcels, array[(v_file.box - 1)::text, 'label_file'], to_jsonb(v_file_id::text));
      v_kept := v_kept + 1;
    exception when others then
      -- Not a file we can keep (too big, not a kind we know). The label itself still is.
      null;
    end;
  end loop;

  if v_kept > 0 then
    update public.shipping_label_quotes q set parcels = v_parcels where q.id = v_quote.id;
  end if;
  return v_kept;
end;
$$;

-- ---------------------------------------------------------------------------
-- Who may call what
-- ---------------------------------------------------------------------------

revoke all on function public.mark_label_printed(uuid) from public, anon;
grant execute on function public.mark_label_printed(uuid) to authenticated;

revoke all on function public.keep_label_files(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.keep_label_files(uuid, uuid, jsonb) to service_role;
