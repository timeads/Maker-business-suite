-- Help desk, sixth pass: the smaller things the owner's help desk has.
-- Acting on several conversations at once, tag changes in the activity log,
-- a short wait before an email really goes (so a send can be taken back),
-- what a saved reply also does when it is sent, and throwing away a
-- conversation that was started but never written.

alter table public.ticket_events drop constraint ticket_events_kind_check;
alter table public.ticket_events add constraint ticket_events_kind_check check (kind in
  ('status', 'assigned', 'priority', 'snoozed', 'unsnoozed', 'folder', 'subject', 'merged',
   'forwarded', 'shelf', 'tags'));

-- ---------------------------------------------------------------------------
-- Tag changes are written down: "+refund", "-refund". With nobody signed in
-- (a rule tagging new mail) the line has no actor.
-- ---------------------------------------------------------------------------

create function private.log_ticket_tag()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.ticket_tags;
  v_name text;
begin
  if tg_op = 'DELETE' then
    v_row := old;
  else
    v_row := new;
  end if;
  -- A tag leaving because its conversation (or the tag itself) is being
  -- deleted is not a change anyone made to the conversation.
  if not exists (select 1 from public.tickets t where t.id = v_row.ticket_id) then
    return null;
  end if;
  select g.name into v_name from public.tags g where g.id = v_row.tag_id;
  if v_name is null then
    return null;
  end if;
  insert into public.ticket_events (tenant_id, ticket_id, actor_id, kind, detail)
  values (v_row.tenant_id, v_row.ticket_id, auth.uid(), 'tags',
          case when tg_op = 'DELETE' then '-' else '+' end || v_name);
  return null;
end;
$$;
revoke all on function private.log_ticket_tag() from public;
create trigger ticket_tags_log
  after insert or delete on public.ticket_tags
  for each row execute function private.log_ticket_tag();

-- Sets a conversation's tags to the list given. Only what really changes is
-- touched, so the log shows what was added and what was taken off.
create or replace function public.set_ticket_tags(p_ticket_id uuid, p_tags text[])
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_ticket public.tickets := private.member_ticket(p_ticket_id);
  v_names text[] := coalesce(
    (select array_agg(distinct lower(btrim(x))) from unnest(coalesce(p_tags, '{}')) as x), '{}');
begin
  delete from public.ticket_tags tt
  using public.tags g
  where tt.ticket_id = v_ticket.id and g.id = tt.tag_id and not (g.name = any (v_names));
  perform private.add_ticket_tags(v_ticket.tenant_id, v_ticket.id, v_names);
end;
$$;

-- ---------------------------------------------------------------------------
-- Several conversations at once. One request, checked here: every id must be
-- a conversation of the workspace named, and the person a member of it.
--   p_change keys (any mix): status, snooze_until, assignee, priority, folder,
--   shelf, add_tags, remove_tags. A key that is present with null clears
--   (assignee, folder, shelf).
-- Returns how many conversations it covered.
-- ---------------------------------------------------------------------------

create function public.bulk_update_tickets(p_tenant_id uuid, p_ticket_ids uuid[], p_change jsonb)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_ids uuid[];
  v_id uuid;
  v_until timestamptz;
  v_person uuid;
  v_folder uuid;
  v_shelf text;
  v_status text := p_change ->> 'status';
begin
  if not private.is_member(p_tenant_id, auth.uid()) then
    raise exception 'Workspace not found' using errcode = 'P0002';
  end if;
  if coalesce(array_length(p_ticket_ids, 1), 0) = 0 or array_length(p_ticket_ids, 1) > 200 then
    raise exception 'Tick between one and 200 conversations' using errcode = '22023';
  end if;
  if jsonb_typeof(p_change) is distinct from 'object' then
    raise exception 'Nothing to change' using errcode = '22023';
  end if;
  -- Locked in a fixed order, and only those that are this workspace's own.
  perform 1 from public.tickets t
  where t.tenant_id = p_tenant_id and t.id = any (p_ticket_ids) and t.merged_into is null
  order by t.id for update;
  select coalesce(array_agg(t.id), '{}') into v_ids from public.tickets t
  where t.tenant_id = p_tenant_id and t.id = any (p_ticket_ids) and t.merged_into is null;
  if array_length(v_ids, 1) is null then
    return 0;
  end if;

  if p_change ? 'shelf' then
    v_shelf := p_change ->> 'shelf';
    if v_shelf is not null and v_shelf not in ('archived', 'spam', 'trash') then
      raise exception 'Unknown place to put a conversation' using errcode = '22023';
    end if;
    if v_shelf is null then
      update public.tickets t
      set shelf = null, shelved_at = null, status = 'open', closed_at = null
      where t.id = any (v_ids) and t.shelf is not null;
    else
      update public.tickets t
      set shelf = v_shelf, shelved_at = now(), status = 'closed', snoozed_until = null,
          closed_at = case when v_shelf = 'archived' then coalesce(t.closed_at, now()) end
      where t.id = any (v_ids) and t.shelf is distinct from v_shelf;
    end if;
  end if;

  if v_status is not null then
    if v_status not in ('open', 'pending', 'closed') then
      raise exception 'Unknown status' using errcode = '22023';
    end if;
    update public.tickets t
    set status = v_status::public.ticket_status,
        closed_at = case when v_status = 'closed' then coalesce(t.closed_at, now()) end,
        snoozed_until = case when v_status = 'closed' then null else t.snoozed_until end
    where t.id = any (v_ids) and t.status::text <> v_status;
  end if;

  if p_change ? 'snooze_until' then
    v_until := (p_change ->> 'snooze_until')::timestamptz;
    if v_until is not null and (v_until <= now() or v_until > now() + interval '366 days') then
      raise exception 'Pick a time in the coming year' using errcode = '22023';
    end if;
    update public.tickets t set snoozed_until = v_until
    where t.id = any (v_ids) and t.status <> 'closed';
  end if;

  if p_change ? 'assignee' then
    v_person := (p_change ->> 'assignee')::uuid;
    if v_person is not null and not private.is_member(p_tenant_id, v_person) then
      raise exception 'That person is not in this workspace' using errcode = 'P0002';
    end if;
    update public.tickets t set assignee_id = v_person
    where t.id = any (v_ids) and t.assignee_id is distinct from v_person;
  end if;

  if p_change ? 'priority' then
    if p_change ->> 'priority' not in ('low', 'normal', 'high', 'urgent') then
      raise exception 'Unknown priority' using errcode = '22023';
    end if;
    update public.tickets t set priority = p_change ->> 'priority'
    where t.id = any (v_ids) and t.priority <> p_change ->> 'priority';
  end if;

  if p_change ? 'folder' then
    v_folder := (p_change ->> 'folder')::uuid;
    if v_folder is not null and not exists (
      select 1 from public.ticket_folders f where f.id = v_folder and f.tenant_id = p_tenant_id
    ) then
      raise exception 'Folder not found' using errcode = 'P0002';
    end if;
    update public.tickets t set folder_id = v_folder
    where t.id = any (v_ids) and t.folder_id is distinct from v_folder;
  end if;

  if p_change ? 'remove_tags' then
    delete from public.ticket_tags tt
    using public.tags g
    where tt.ticket_id = any (v_ids) and g.id = tt.tag_id
      and g.name in (select lower(btrim(x)) from jsonb_array_elements_text(p_change -> 'remove_tags') as x);
  end if;
  if p_change ? 'add_tags' then
    foreach v_id in array v_ids loop
      perform private.add_ticket_tags(p_tenant_id, v_id,
        array(select x from jsonb_array_elements_text(p_change -> 'add_tags') as x limit 10));
    end loop;
  end if;
  return array_length(v_ids, 1);
end;
$$;

-- What a saved reply also does when it is sent: add tags, hand the
-- conversation to someone.
create function public.apply_send_actions(p_ticket_id uuid, p_add_tags text[], p_assign_to uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_ticket public.tickets := private.member_ticket(p_ticket_id);
begin
  if coalesce(array_length(p_add_tags, 1), 0) > 0 then
    perform private.add_ticket_tags(v_ticket.tenant_id, v_ticket.id, p_add_tags[1:10]);
  end if;
  if p_assign_to is not null and private.is_member(v_ticket.tenant_id, p_assign_to) then
    update public.tickets t set assignee_id = p_assign_to
    where t.id = v_ticket.id and t.assignee_id is distinct from p_assign_to;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Email waiting to go. "Undo send" is a short wait on the server: the email
-- sits here until its time, the worker sends it, and until then whoever can
-- see the conversation can take it back. Nothing depends on a browser staying
-- open. The email's own contents are cleared as soon as it has gone, been
-- taken back, or failed.
-- ---------------------------------------------------------------------------

create table private.outbound_queue (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  ticket_id uuid not null references public.tickets (id) on delete cascade,
  author_id uuid not null references auth.users (id) on delete cascade,
  -- Everything needed to send: who to, the words, the files, what happens next.
  payload jsonb not null,
  -- What the conversation shows while it waits: {kind, to, preview}.
  summary jsonb not null default '{}'::jsonb,
  send_at timestamptz not null,
  state text not null default 'waiting'
    check (state in ('waiting', 'sending', 'sent', 'cancelled', 'failed', 'unsure')),
  error text,
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index outbound_queue_due_idx on private.outbound_queue (send_at) where state = 'waiting';
create index outbound_queue_ticket_idx on private.outbound_queue (ticket_id);
alter table private.outbound_queue enable row level security;
revoke all on private.outbound_queue from public, anon, authenticated, service_role;

create function public.queue_outbound(
  p_ticket_id uuid, p_payload jsonb, p_summary jsonb, p_delay_seconds int
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_ticket public.tickets := private.member_ticket(p_ticket_id);
  v_id uuid;
begin
  if v_ticket.merged_into is not null then
    raise exception 'This conversation was joined into another one' using errcode = '22023';
  end if;
  if p_delay_seconds is null or p_delay_seconds < 1 or p_delay_seconds > 60 then
    raise exception 'The wait before sending is between 1 and 60 seconds' using errcode = '22023';
  end if;
  if jsonb_typeof(p_payload) is distinct from 'object' or pg_column_size(p_payload) > 16000000 then
    raise exception 'That email is too big to send' using errcode = '22023';
  end if;
  if (select count(*) from private.outbound_queue q
      where q.ticket_id = v_ticket.id and q.state in ('waiting', 'sending')) >= 5 then
    raise exception 'Too many emails are already waiting to go on this conversation' using errcode = '22023';
  end if;
  insert into private.outbound_queue (tenant_id, ticket_id, author_id, payload, summary, send_at)
  values (v_ticket.tenant_id, v_ticket.id, auth.uid(), p_payload,
          coalesce(p_summary, '{}'::jsonb), now() + make_interval(secs => p_delay_seconds))
  returning id into v_id;
  return v_id;
end;
$$;

-- Takes a waiting email back. True if it was still waiting (so it will never
-- go); false if the worker already has it or it has gone.
create function public.cancel_outbound(p_id uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_done int;
begin
  update private.outbound_queue q
  set state = 'cancelled', payload = '{}'::jsonb, finished_at = now()
  where q.id = p_id and q.state = 'waiting'
    and q.tenant_id in (select private.user_tenant_ids());
  get diagnostics v_done = row_count;
  return v_done = 1;
end;
$$;

-- What is waiting, going or went wrong on a conversation, for its page.
create function public.ticket_outbox(p_ticket_id uuid)
returns table (
  id uuid, state text, send_at timestamptz, summary jsonb, error text, author_id uuid,
  created_at timestamptz, doc jsonb
)
language sql stable security definer set search_path = ''
as $$
  select q.id, q.state, q.send_at, q.summary, q.error, q.author_id, q.created_at,
         -- The words come back only for an email that failed, so they can be put back in the box.
         case when q.state = 'failed' then q.payload -> 'doc' end
  from private.outbound_queue q
  where q.ticket_id = p_ticket_id
    and q.tenant_id in (select private.user_tenant_ids())
    and q.state in ('waiting', 'sending', 'failed', 'unsure')
  order by q.created_at;
$$;

-- Clears the notice about an email that failed.
create function public.dismiss_outbound(p_id uuid)
returns void
language sql security definer set search_path = ''
as $$
  delete from private.outbound_queue q
  where q.id = p_id and q.state in ('failed', 'unsure')
    and q.tenant_id in (select private.user_tenant_ids());
$$;

-- The worker's turn (service role). An email claimed and never finished is
-- marked "unsure" and is never sent again by itself: it may have gone.
create function public.claim_outbound(p_limit int default 5)
returns table (id uuid, tenant_id uuid, ticket_id uuid, author_id uuid, payload jsonb)
language plpgsql security definer set search_path = ''
as $$
begin
  update private.outbound_queue q
  set state = 'unsure', error = 'never_finished', payload = '{}'::jsonb, finished_at = now()
  where q.state = 'sending' and q.locked_at < now() - interval '10 minutes';

  -- Whoever wrote it has left the workspace since: it doesn't go.
  update private.outbound_queue q
  set state = 'failed', error = 'author_left', payload = q.payload - 'files', finished_at = now()
  where q.state = 'waiting' and q.send_at <= now()
    and not private.is_member(q.tenant_id, q.author_id);

  return query
  update private.outbound_queue q
  set state = 'sending', locked_at = now()
  where q.id in (
    select s.id from private.outbound_queue s
    where s.state = 'waiting' and s.send_at <= now()
    order by s.send_at
    limit greatest(1, least(coalesce(p_limit, 5), 20))
    for update skip locked
  )
  returning q.id, q.tenant_id, q.ticket_id, q.author_id, q.payload;
end;
$$;

-- Writes down how a send went. On success the email is filed exactly as if
-- its author had pressed send just now (the same function, acting as them),
-- and the saved reply's extras are applied. Returns the new message's id.
create function public.finish_outbound(
  p_id uuid,
  p_provider_message_id text default null,
  p_from_email text default null,
  p_body text default null,
  p_attachments jsonb default '[]'::jsonb,
  p_error text default null
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_row private.outbound_queue;
  v_then text;
  v_until timestamptz;
  v_message uuid;
begin
  select * into v_row from private.outbound_queue q where q.id = p_id and q.state = 'sending' for update;
  if not found then
    return null;
  end if;
  if p_error is not null or p_provider_message_id is null then
    -- The mail service said no: nothing went. The words are kept so they can be put back.
    update private.outbound_queue q
    set state = 'failed', error = left(coalesce(p_error, 'unknown'), 200),
        payload = q.payload - 'files', finished_at = now()
    where q.id = p_id;
    return null;
  end if;

  v_then := coalesce(v_row.payload ->> 'then', 'pending');
  v_until := (v_row.payload ->> 'snooze_until')::timestamptz;
  if v_then = 'snoozed' and (v_until is null or v_until <= now()) then
    v_then := 'pending';
    v_until := null;
  end if;
  begin
    -- From here on this transaction acts as the person who wrote the email.
    perform set_config('request.jwt.claims',
      jsonb_build_object('sub', v_row.author_id, 'role', 'authenticated')::text, true);
    v_message := public.record_outbound(
      v_row.ticket_id, p_body, p_from_email, p_provider_message_id,
      coalesce(v_row.payload ->> 'kind', 'reply'),
      array(select jsonb_array_elements_text(coalesce(v_row.payload -> 'to', '[]'::jsonb))),
      array(select jsonb_array_elements_text(coalesce(v_row.payload -> 'cc', '[]'::jsonb))),
      case when jsonb_typeof(v_row.payload -> 'format') = 'array' then v_row.payload -> 'format' end,
      coalesce(p_attachments, '[]'::jsonb), v_then, v_until);
    perform public.apply_send_actions(
      v_row.ticket_id,
      array(select jsonb_array_elements_text(coalesce(v_row.payload -> 'add_tags', '[]'::jsonb))),
      (v_row.payload ->> 'assign_to')::uuid);
    insert into public.ticket_reads (tenant_id, ticket_id, user_id)
    values (v_row.tenant_id, v_row.ticket_id, v_row.author_id)
    on conflict (ticket_id, user_id) do update set read_at = now();
  exception when others then
    -- The email has gone; only the filing failed. Say so rather than lose it.
    update private.outbound_queue q
    set state = 'unsure', error = 'sent_not_filed', payload = '{}'::jsonb, finished_at = now()
    where q.id = p_id;
    return null;
  end;
  update private.outbound_queue q
  set state = 'sent', payload = '{}'::jsonb, finished_at = now()
  where q.id = p_id;
  return v_message;
end;
$$;

-- A conversation that was started and never written (its first email failed
-- or was taken back): whoever is on the team can throw it away, as long as
-- nothing was ever said on it and nothing is waiting to go.
create function public.discard_empty_ticket(p_ticket_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_ticket public.tickets := private.member_ticket(p_ticket_id);
begin
  if exists (select 1 from public.messages m where m.ticket_id = v_ticket.id)
     or exists (select 1 from public.ticket_notes n where n.ticket_id = v_ticket.id)
     or exists (select 1 from private.outbound_queue q
                where q.ticket_id = v_ticket.id and q.state in ('waiting', 'sending', 'unsure')) then
    raise exception 'Only an empty conversation can be removed this way' using errcode = '22023';
  end if;
  delete from public.tickets t where t.id = v_ticket.id;
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.bulk_update_tickets(uuid, uuid[], jsonb)',
    'public.apply_send_actions(uuid, text[], uuid)',
    'public.queue_outbound(uuid, jsonb, jsonb, int)',
    'public.cancel_outbound(uuid)',
    'public.ticket_outbox(uuid)',
    'public.dismiss_outbound(uuid)',
    'public.discard_empty_ticket(uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
  foreach fn in array array[
    'public.claim_outbound(int)',
    'public.finish_outbound(uuid, text, text, text, jsonb, text)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
