-- Help desk, fifth pass: Archive, Spam and Trash.
-- Three shelves a conversation can be put on, as the owner's help desk has
-- them. A shelved conversation is closed and out of every working view.
--   archived: done with, kept. A customer writing back brings it to the inbox.
--   spam:     stays put when more mail arrives on it; "Not spam" reopens it.
--   trash:    stays put too; "Restore" reopens it. Nothing empties the Trash
--             by itself: an owner or admin deletes for good, and only from there.

alter table public.tickets
  add column shelf text check (shelf in ('archived', 'spam', 'trash')),
  add column shelved_at timestamptz;
create index tickets_tenant_shelf_idx on public.tickets (tenant_id, shelf, last_message_at desc)
  where shelf is not null;
grant select (shelf, shelved_at) on public.tickets to authenticated;

alter table public.ticket_events drop constraint ticket_events_kind_check;
alter table public.ticket_events add constraint ticket_events_kind_check check (kind in
  ('status', 'assigned', 'priority', 'snoozed', 'unsnoozed', 'folder', 'subject', 'merged',
   'forwarded', 'shelf'));

-- Anything that takes a shelved conversation out of "closed" (a reply sent,
-- "Reopen", a customer writing to an archived one) takes it off its shelf, so
-- no function has to remember to.
create function private.unshelve_on_reopen()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if old.shelf is not null and new.shelf is not distinct from old.shelf and new.status <> 'closed' then
    new.shelf := null;
    new.shelved_at := null;
  end if;
  return new;
end;
$$;
revoke all on function private.unshelve_on_reopen() from public;
create trigger tickets_unshelve_on_reopen
  before update on public.tickets
  for each row execute function private.unshelve_on_reopen();

-- The activity log learns the shelves. Putting something on a shelf is one
-- line ("archived"), not two ("closed" as well).
create or replace function private.log_ticket_event()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
begin
  if new.shelf is distinct from old.shelf then
    if new.shelf is not null then
      insert into public.ticket_events (tenant_id, ticket_id, actor_id, kind, detail)
      values (new.tenant_id, new.id, v_actor, 'shelf', new.shelf);
    elsif v_actor is null and new.status = 'open' then
      insert into public.ticket_events (tenant_id, ticket_id, actor_id, kind, detail)
      values (new.tenant_id, new.id, null, 'status', 'open|customer');
    else
      insert into public.ticket_events (tenant_id, ticket_id, actor_id, kind, detail)
      values (new.tenant_id, new.id, v_actor, 'shelf', 'restored|' || old.shelf);
    end if;
  elsif new.status is distinct from old.status then
    insert into public.ticket_events (tenant_id, ticket_id, actor_id, kind, detail)
    values (new.tenant_id, new.id, v_actor, 'status',
            new.status::text || case when v_actor is null and new.status = 'open' then '|customer' else '' end);
  elsif old.snoozed_until is not null and old.snoozed_until > now() and new.snoozed_until is null then
    insert into public.ticket_events (tenant_id, ticket_id, actor_id, kind, detail)
    values (new.tenant_id, new.id, v_actor, 'unsnoozed', case when v_actor is null then 'customer' else '' end);
  end if;
  if new.snoozed_until is not null and new.snoozed_until is distinct from old.snoozed_until then
    insert into public.ticket_events (tenant_id, ticket_id, actor_id, kind, detail)
    values (new.tenant_id, new.id, v_actor, 'snoozed',
            to_char(new.snoozed_until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  end if;
  if new.assignee_id is distinct from old.assignee_id then
    insert into public.ticket_events (tenant_id, ticket_id, actor_id, kind, detail)
    values (new.tenant_id, new.id, v_actor, 'assigned', coalesce(new.assignee_id::text, ''));
  end if;
  if new.priority is distinct from old.priority then
    insert into public.ticket_events (tenant_id, ticket_id, actor_id, kind, detail)
    values (new.tenant_id, new.id, v_actor, 'priority', new.priority);
  end if;
  if new.folder_id is distinct from old.folder_id then
    insert into public.ticket_events (tenant_id, ticket_id, actor_id, kind, detail)
    values (new.tenant_id, new.id, v_actor, 'folder',
            coalesce((select f.name from public.ticket_folders f where f.id = new.folder_id), ''));
  end if;
  -- The words of a subject are the customer's; only the fact is noted.
  if new.subject is distinct from old.subject then
    insert into public.ticket_events (tenant_id, ticket_id, actor_id, kind)
    values (new.tenant_id, new.id, v_actor, 'subject');
  end if;
  if new.merged_into is not null and old.merged_into is null then
    insert into public.ticket_events (tenant_id, ticket_id, actor_id, kind, detail)
    values (new.tenant_id, new.merged_into, v_actor, 'merged', '#' || new.number);
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- What members do
-- ---------------------------------------------------------------------------

-- Puts a conversation on a shelf, or (null) takes it off and reopens it.
create function public.shelve_ticket(p_ticket_id uuid, p_shelf text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_ticket public.tickets := private.member_ticket(p_ticket_id);
begin
  if p_shelf is not null and p_shelf not in ('archived', 'spam', 'trash') then
    raise exception 'Unknown place to put a conversation' using errcode = '22023';
  end if;
  if v_ticket.merged_into is not null then
    raise exception 'This conversation was joined into another one' using errcode = '22023';
  end if;
  if p_shelf is null then
    update public.tickets t
    set shelf = null, shelved_at = null, status = 'open', closed_at = null
    where t.id = v_ticket.id and t.shelf is not null;
  elsif v_ticket.shelf is distinct from p_shelf then
    update public.tickets t
    set shelf = p_shelf, shelved_at = now(), status = 'closed', snoozed_until = null,
        -- Archived counts as dealt with; spam and trash were never ours to answer.
        closed_at = case when p_shelf = 'archived' then coalesce(t.closed_at, now()) end
    where t.id = v_ticket.id;
  end if;
end;
$$;

-- Gone for good: the conversation, its emails, notes and files. Owners and
-- admins only, and only from the Trash, so it always takes two steps.
create function public.delete_ticket_for_good(p_ticket_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_ticket public.tickets := private.member_ticket(p_ticket_id);
begin
  perform private.require_manager(v_ticket.tenant_id);
  if v_ticket.shelf is distinct from 'trash' then
    raise exception 'Move it to the Trash first' using errcode = '22023';
  end if;
  delete from public.tickets t where t.id = v_ticket.id;
  perform private.log_audit(v_ticket.tenant_id, 'helpdesk.ticket_deleted', 'ticket',
    v_ticket.number::text, '{}'::jsonb);
end;
$$;

create function public.empty_ticket_trash(p_tenant_id uuid)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  perform private.require_manager(p_tenant_id);
  delete from public.tickets t where t.tenant_id = p_tenant_id and t.shelf = 'trash';
  get diagnostics v_count = row_count;
  if v_count > 0 then
    perform private.log_audit(p_tenant_id, 'helpdesk.trash_emptied', 'ticket', null,
      jsonb_build_object('conversations', v_count));
  end if;
  return v_count;
end;
$$;

revoke all on function public.shelve_ticket(uuid, text) from public, anon;
revoke all on function public.delete_ticket_for_good(uuid) from public, anon;
revoke all on function public.empty_ticket_trash(uuid) from public, anon;
grant execute on function public.shelve_ticket(uuid, text) to authenticated;
grant execute on function public.delete_ticket_for_good(uuid) to authenticated;
grant execute on function public.empty_ticket_trash(uuid) to authenticated;

-- Nothing is joined into Spam or Trash, and a joined-away conversation
-- leaves whatever shelf it was on.
create or replace function public.merge_tickets(p_from_ticket_id uuid, p_into_ticket_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_from public.tickets;
  v_into public.tickets;
begin
  if p_from_ticket_id = p_into_ticket_id then
    raise exception 'Pick a different conversation' using errcode = '22023';
  end if;
  -- Lock in a fixed order so two merges can't wait on each other.
  if p_from_ticket_id < p_into_ticket_id then
    v_from := private.member_ticket(p_from_ticket_id);
    v_into := private.member_ticket(p_into_ticket_id);
  else
    v_into := private.member_ticket(p_into_ticket_id);
    v_from := private.member_ticket(p_from_ticket_id);
  end if;
  if v_from.tenant_id <> v_into.tenant_id or v_from.merged_into is not null
     or v_into.merged_into is not null or v_into.shelf in ('spam', 'trash') then
    raise exception 'Those two can''t be joined' using errcode = '22023';
  end if;
  update public.messages m set ticket_id = v_into.id where m.ticket_id = v_from.id;
  update public.ticket_notes n set ticket_id = v_into.id where n.ticket_id = v_from.id;
  insert into public.ticket_tags (tenant_id, ticket_id, tag_id)
  select tt.tenant_id, v_into.id, tt.tag_id from public.ticket_tags tt where tt.ticket_id = v_from.id
  on conflict do nothing;
  update public.tickets t
  set merged_into = v_into.id, status = 'closed', closed_at = coalesce(t.closed_at, now()),
      snoozed_until = null, shelf = null, shelved_at = null
  where t.id = v_from.id;
  update public.tickets t
  set last_message_at = greatest(t.last_message_at, v_from.last_message_at),
      status = case when v_from.status = 'open' then 'open' else t.status end
  where t.id = v_into.id;
  insert into public.ticket_notes (tenant_id, ticket_id, author_id, body)
  values (v_into.tenant_id, v_into.id, auth.uid(),
          'Joined conversation #' || v_from.number || ' ("' || left(v_from.subject, 80) || '") into this one.');
end;
$$;


-- ---------------------------------------------------------------------------
-- Incoming email: Spam and Trash stay put
-- ---------------------------------------------------------------------------

create or replace function public.file_inbound_email(
  p_slug text,
  p_provider_message_id text,
  p_from_email text,
  p_from_name text,
  p_subject text,
  p_body text,
  p_message_id text default null,
  p_reply_key text default null,
  p_references text[] default '{}',
  p_tags text[] default '{}',
  p_to text[] default '{}',
  p_cc text[] default '{}'
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_email text := lower(btrim(coalesce(p_from_email, '')));
  v_contact_id uuid;
  v_ticket public.tickets;
  v_created boolean := false;
  v_message public.messages;
begin
  -- Locking the workspace row keeps ticket numbers gap-free and in order.
  select t.id into v_tenant_id from public.tenants t where t.slug = p_slug for update;
  if v_tenant_id is null then
    return jsonb_build_object('result', 'unknown_workspace');
  end if;
  if v_email = '' then
    raise exception 'Inbound email has no sender';
  end if;
  select * into v_message from public.messages m
  where m.tenant_id = v_tenant_id and m.provider_message_id = p_provider_message_id;
  if v_message.id is not null then
    return jsonb_build_object('result', 'duplicate', 'tenant_id', v_tenant_id,
                              'ticket_id', v_message.ticket_id, 'message_id', v_message.id);
  end if;

  insert into public.contacts (tenant_id, email, name)
  values (v_tenant_id, v_email, nullif(btrim(coalesce(p_from_name, '')), ''))
  on conflict (tenant_id, email) do update
    set name = coalesce(public.contacts.name, excluded.name)
  returning id into v_contact_id;

  if p_reply_key is not null then
    select * into v_ticket from public.tickets t
    where t.tenant_id = v_tenant_id and t.reply_key = p_reply_key;
  end if;
  if v_ticket.id is null and coalesce(array_length(p_references, 1), 0) > 0 then
    select t.* into v_ticket
    from public.messages m
    join public.tickets t on t.id = m.ticket_id
    where m.tenant_id = v_tenant_id and m.message_id = any (p_references)
    order by m.created_at desc
    limit 1;
  end if;
  -- Follow a folded conversation to where it went (a few hops at most).
  for i in 1 .. 5 loop
    exit when v_ticket.id is null or v_ticket.merged_into is null;
    select * into v_ticket from public.tickets t
    where t.id = v_ticket.merged_into and t.tenant_id = v_tenant_id;
  end loop;

  if v_ticket.id is null then
    insert into public.tickets (tenant_id, number, contact_id, subject, reply_key)
    values (
      v_tenant_id,
      (select coalesce(max(t.number), 0) + 1 from public.tickets t where t.tenant_id = v_tenant_id),
      v_contact_id,
      left(coalesce(nullif(btrim(p_subject), ''), '(no subject)'), 200),
      replace(gen_random_uuid()::text, '-', '')
    )
    returning * into v_ticket;
    v_created := true;
  elsif v_ticket.shelf in ('spam', 'trash') then
    -- Spam and Trash stay put: the email is kept with the conversation, and
    -- nothing comes back to the inbox.
    update public.tickets t set last_message_at = now() where t.id = v_ticket.id;
  else
    -- A customer writing back reopens the conversation and wakes it. (An
    -- archived one comes off its shelf: see private.unshelve_on_reopen.)
    update public.tickets t
    set status = 'open', last_message_at = now(), snoozed_until = null, closed_at = null
    where t.id = v_ticket.id;
  end if;

  insert into public.messages
    (tenant_id, ticket_id, direction, from_email, from_name, body, message_id, provider_message_id,
     to_emails, cc_emails)
  values
    (v_tenant_id, v_ticket.id, 'inbound', v_email, nullif(btrim(coalesce(p_from_name, '')), ''),
     coalesce(p_body, ''), p_message_id, p_provider_message_id,
     coalesce((select array_agg(lower(btrim(e))) from unnest(p_to[1:10]) as e where btrim(e) <> ''), '{}'),
     coalesce((select array_agg(lower(btrim(e))) from unnest(p_cc[1:10]) as e where btrim(e) <> ''), '{}'))
  returning * into v_message;

  perform private.add_ticket_tags(v_tenant_id, v_ticket.id, p_tags);

  return jsonb_build_object(
    'result', case when v_created then 'created' else 'threaded' end,
    'tenant_id', v_tenant_id,
    'ticket_id', v_ticket.id,
    'message_id', v_message.id,
    'number', v_ticket.number,
    'kept_in', v_ticket.shelf
  );
end;
$$;
