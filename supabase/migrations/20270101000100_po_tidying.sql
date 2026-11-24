-- Purchase orders, tidied the way TuftStock lets you: rename an order's
-- reference, delete a draft that was never used, put a finished order away
-- ("archive"), and keep a short log of who did what to it.
--
-- The log holds only what no other table already says: who sent the order,
-- put it back to draft, closed, cancelled, renamed or archived it, and when.
-- Deliveries, emails and tracking numbers have their own tables with their
-- own times and people; the order's page puts them all on one timeline when
-- it is read (lib/stock/po/timeline.ts). Nothing is copied.

alter table public.purchase_orders
  add column archived_at timestamptz,
  add column archived_by uuid references auth.users (id) on delete set null;

create table public.purchase_order_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  po_id uuid not null references public.purchase_orders (id) on delete cascade,
  kind text not null check (kind in (
    'sent', 'back_to_draft', 'closed', 'cancelled', 'renamed', 'archived', 'unarchived')),
  -- For a rename: "OLD → NEW". Empty otherwise.
  detail text not null default '' check (char_length(detail) <= 200),
  -- Who did it. Null when it happened by itself (the last delivery closing
  -- an order) or the person has since left.
  actor uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index purchase_order_events_po_idx
  on public.purchase_order_events (tenant_id, po_id, created_at);

alter table public.purchase_order_events enable row level security;
create policy "members read their purchase_order_events" on public.purchase_order_events
  for select to authenticated
  using (tenant_id in (select private.user_tenant_ids()));
-- Read by the team; written only by the trigger below.
revoke all on public.purchase_order_events from public, anon, authenticated, service_role;
grant select on public.purchase_order_events to authenticated, service_role;

-- Every change to an order goes through an update of its row, so the log is
-- written here and no screen or function can forget to.
create function private.purchase_orders_log()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_kind text;
begin
  if new.status is distinct from old.status then
    v_kind := case
      when new.status = 'ordered' and old.status = 'draft' then 'sent'
      when new.status = 'draft' then 'back_to_draft'
      when new.status = 'closed' then 'closed'
      when new.status = 'cancelled' then 'cancelled'
      else null
    end;
    if v_kind is not null then
      insert into public.purchase_order_events (tenant_id, po_id, kind, actor)
      values (new.tenant_id, new.id, v_kind, (select auth.uid()));
    end if;
  end if;
  if new.reference is distinct from old.reference then
    insert into public.purchase_order_events (tenant_id, po_id, kind, detail, actor)
    values (new.tenant_id, new.id, 'renamed',
            left(old.reference || ' → ' || new.reference, 200), (select auth.uid()));
  end if;
  if (new.archived_at is null) <> (old.archived_at is null) then
    insert into public.purchase_order_events (tenant_id, po_id, kind, actor)
    values (new.tenant_id, new.id,
            case when new.archived_at is null then 'unarchived' else 'archived' end,
            (select auth.uid()));
  end if;
  return new;
end;
$$;
revoke all on function private.purchase_orders_log() from public;

create trigger purchase_orders_log
  after update on public.purchase_orders
  for each row execute function private.purchase_orders_log();

-- Gives an order a name of the workspace's own choosing. Letters, digits and
-- a few plain marks; no two orders in a workspace share one, whatever the
-- capitals. The plain number still opens the order in its address. A
-- finished order keeps the name it had, as in TuftStock.
create function public.rename_purchase_order(p_po_id uuid, p_reference text)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_po public.purchase_orders := private.manager_po(p_po_id);
  v_reference text := regexp_replace(btrim(coalesce(p_reference, '')), '\s+', ' ', 'g');
begin
  if v_po.status in ('closed', 'cancelled') or v_po.archived_at is not null then
    raise exception 'finished_order' using errcode = 'P0001';
  end if;
  if char_length(v_reference) not between 3 and 40
     or v_reference !~ '^[A-Za-z0-9][A-Za-z0-9 ._/#-]*$' then
    raise exception 'bad_reference' using errcode = '22023';
  end if;
  if v_reference = v_po.reference then
    return v_reference;
  end if;
  if exists (
    select 1 from public.purchase_orders po
    where po.tenant_id = v_po.tenant_id and po.id <> v_po.id
      and upper(po.reference) = upper(v_reference)
  ) then
    raise exception 'reference_taken' using errcode = '23505';
  end if;
  update public.purchase_orders po set reference = v_reference where po.id = v_po.id;
  return v_reference;
end;
$$;

-- Puts an order away, out of the everyday lists, or brings it back. Only an
-- order nothing is still expected on: a draft, or one that is closed or
-- cancelled. (One that has been sent still counts as stock on its way, so it
-- is closed or cancelled first.)
create function public.archive_purchase_order(p_po_id uuid, p_archived boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_po public.purchase_orders := private.manager_po(p_po_id);
begin
  if coalesce(p_archived, true) then
    if v_po.status in ('ordered', 'partial') then
      raise exception 'still_open' using errcode = 'P0001';
    end if;
    update public.purchase_orders po
    set archived_at = coalesce(po.archived_at, now()),
        archived_by = coalesce(po.archived_by, (select auth.uid()))
    where po.id = v_po.id;
  else
    update public.purchase_orders po set archived_at = null, archived_by = null
    where po.id = v_po.id;
  end if;
end;
$$;

-- Deletes a draft for good. Only a draft that left no trace outside itself:
-- nothing was ever checked in on it and it was never emailed to a supplier
-- (one that was is cancelled or archived instead, so the record stays).
create function public.delete_draft_purchase_order(p_po_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_po public.purchase_orders := private.manager_po(p_po_id);
begin
  if v_po.status <> 'draft' then
    raise exception 'not_a_draft' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.purchase_order_lines l
    where l.po_id = v_po.id
      and (l.qty_received > 0
           or exists (select 1 from public.stock_receipts r where r.po_line_id = l.id))
  ) or exists (
    select 1 from public.purchase_order_emails e
    where e.po_id = v_po.id and e.status <> 'failed'
  ) then
    raise exception 'has_history' using errcode = 'P0001';
  end if;
  delete from public.purchase_orders po where po.id = v_po.id and po.tenant_id = v_po.tenant_id;
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.rename_purchase_order(uuid, text)',
    'public.archive_purchase_order(uuid, boolean)',
    'public.delete_draft_purchase_order(uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;
