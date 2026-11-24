-- Packing slips for an order going out in several boxes.
--
-- Before a label is bought, which items go in which box comes from the
-- order's plan (a saved choice, a rule, packing memory) and nothing new is
-- stored. Once the label is bought nothing is left on the order to plan, so
-- two small notes are kept on the parcel itself:
--
--   * `box_items`: what went in each box, so every box can still have its
--     own slip (with its own tracking number) and be checked on its own at
--     the packing bench. Line ids and counts, and the box's name; never an
--     address, a customer or a price.
--   * `label_boxes_printed`: which boxes' labels have been printed, and
--     when, for a bench that packs and labels one box at a time.

alter table public.shipments
  -- [{"name": "Medium box" | null, "items": {"<line_id>": 2}}], one per box,
  -- in the order of the label's boxes. Null when it isn't known.
  add column box_items jsonb
    check (box_items is null or (
      jsonb_typeof(box_items) = 'array'
      and jsonb_array_length(box_items) between 1 and 6)),
  -- {"1": "2026-12-30T15:00:00Z"}: box number to when its label last printed.
  add column label_boxes_printed jsonb not null default '{}'::jsonb
    check (jsonb_typeof(label_boxes_printed) = 'object');

-- ---------------------------------------------------------------------------
-- What went in each box of a bought label
-- ---------------------------------------------------------------------------

-- Written by the server with the service role, straight after the parcel is
-- recorded, from the boxes the label was priced for. It is a note, and is
-- kept only when it is true of the parcel: one entry per box of the label,
-- only lines the parcel holds, and never more of a line than went in it.
-- Anything else is turned away whole and the parcel keeps one slip, as
-- before. Orders that went out together on one label are left alone.
create function public.note_shipment_boxes(p_tenant_id uuid, p_number int, p_boxes jsonb)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_shipment public.shipments;
  v_labels int;
  v_box jsonb;
  v_items jsonb;
  v_clean jsonb := '[]'::jsonb;
begin
  select * into v_shipment from public.shipments s
  where s.tenant_id = p_tenant_id and s.number = p_number
  for update;
  if not found or v_shipment.voided_at is not null or v_shipment.label_provider is null
     or v_shipment.merged_with is not null then
    return false;
  end if;
  if exists (select 1 from public.shipments r where r.merged_with = v_shipment.id) then
    return false;
  end if;
  if jsonb_typeof(p_boxes) is distinct from 'array' then
    return false;
  end if;
  v_labels := case
    when jsonb_typeof(v_shipment.label_parcels) = 'array'
         and jsonb_array_length(v_shipment.label_parcels) > 0
      then jsonb_array_length(v_shipment.label_parcels)
    else 1 end;
  if jsonb_array_length(p_boxes) not between 1 and 6
     or jsonb_array_length(p_boxes) <> v_labels then
    return false;
  end if;

  for v_box in
    select e.b from jsonb_array_elements(p_boxes) with ordinality as e(b, n) order by e.n
  loop
    if jsonb_typeof(v_box) is distinct from 'object' then
      return false;
    end if;
    select coalesce(jsonb_object_agg(i.key, (i.value #>> '{}')::int), '{}'::jsonb)
    into v_items
    from jsonb_each(
           case when jsonb_typeof(v_box -> 'items') = 'object' then v_box -> 'items'
                else '{}'::jsonb end) i
    where jsonb_typeof(i.value) = 'number'
      and (i.value #>> '{}') ~ '^[0-9]{1,6}$'
      and (i.value #>> '{}')::int > 0;
    v_clean := v_clean || jsonb_build_array(jsonb_build_object(
      'name', nullif(left(btrim(coalesce(v_box ->> 'name', '')), 80), ''),
      'items', v_items));
  end loop;

  -- Nothing said about what went where teaches nothing.
  if not exists (
    select 1 from jsonb_array_elements(v_clean) b, jsonb_each(b -> 'items')) then
    return false;
  end if;
  -- Every line must be one the parcel holds, and never more of it than went.
  if exists (
    select 1
    from (
      select i.key as line_id, sum((i.value #>> '{}')::int) as total
      from jsonb_array_elements(v_clean) b, jsonb_each(b -> 'items') i
      group by i.key) said
    left join lateral (
      select sum(case when (it ->> 'qty') ~ '^[0-9]{1,9}$' then (it ->> 'qty')::int else 0 end) as qty
      from jsonb_array_elements(
             case when jsonb_typeof(v_shipment.items) = 'array' then v_shipment.items
                  else '[]'::jsonb end) it
      where it ->> 'line_id' = said.line_id) went on true
    where went.qty is null or said.total > went.qty) then
    return false;
  end if;

  update public.shipments s set box_items = v_clean where s.id = v_shipment.id;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- One box's label has been printed
-- ---------------------------------------------------------------------------

-- As `mark_label_printed`, for one box of a label with several: anyone on
-- the team packs, so anyone on the team may say so, for their own
-- workspace's parcels. The box is noted on its own, and the parcel's label
-- counts as printed as well (something of it was).
create function public.mark_label_box_printed(p_shipment_id uuid, p_box int)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_shipment public.shipments;
  v_boxes int;
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
  v_boxes := case
    when jsonb_typeof(v_shipment.label_parcels) = 'array'
         and jsonb_array_length(v_shipment.label_parcels) > 0
      then jsonb_array_length(v_shipment.label_parcels)
    else 1 end;
  if p_box is null or p_box not between 1 and v_boxes then
    raise exception 'That parcel has no such box' using errcode = 'P0001';
  end if;
  update public.shipments s
  set label_boxes_printed = s.label_boxes_printed || jsonb_build_object(p_box::text, now()),
      label_printed_at = now(), label_printed_by = auth.uid(),
      label_print_count = s.label_print_count + 1
  where s.id = v_shipment.id
  returning * into v_shipment;
  return jsonb_build_object(
    'shipment_id', v_shipment.id,
    'box', p_box,
    'printed_at', v_shipment.label_printed_at,
    'boxes_printed', v_shipment.label_boxes_printed);
end;
$$;

-- ---------------------------------------------------------------------------
-- Who may call what
-- ---------------------------------------------------------------------------

revoke all on function public.note_shipment_boxes(uuid, int, jsonb)
  from public, anon, authenticated;
grant execute on function public.note_shipment_boxes(uuid, int, jsonb) to service_role;

revoke all on function public.mark_label_box_printed(uuid, int) from public, anon;
grant execute on function public.mark_label_box_printed(uuid, int) to authenticated;
