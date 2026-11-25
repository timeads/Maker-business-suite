-- Help desk, third pass: the three-pane desk.
-- Folders people make, each person's own read marks, a short log of what
-- happened to a conversation, mail that goes out as a forward or with
-- copies, a conversation started by the team, and an AI summary a person
-- asked for. Members read; every write is a function that checks who asks.

-- ---------------------------------------------------------------------------
-- Folders
-- ---------------------------------------------------------------------------

create table public.ticket_folders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 40),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index ticket_folders_name_idx on public.ticket_folders (tenant_id, lower(name));

alter table public.tickets
  -- Filed away from the inbox views; still under All, Closed and searches.
  add column folder_id uuid references public.ticket_folders (id) on delete set null,
  -- Written only when a person presses "Summarize".
  add column ai_summary text check (ai_summary is null or char_length(ai_summary) <= 1200),
  add column ai_mood text check (ai_mood is null or ai_mood in ('positive', 'neutral', 'negative')),
  add column ai_kind text check (ai_kind is null or char_length(ai_kind) <= 40),
  add column ai_updated_at timestamptz;
create index tickets_tenant_folder_idx on public.tickets (tenant_id, folder_id) where folder_id is not null;
grant select (folder_id, ai_summary, ai_mood, ai_kind, ai_updated_at) on public.tickets to authenticated;

alter table public.messages
  add column kind text not null default 'reply' check (kind in ('reply', 'forward')),
  add column to_emails text[] not null default '{}',
  add column cc_emails text[] not null default '{}',
  -- Our own reply as a small document (see lib/helpdesk/rich.ts). Never a customer's HTML.
  add column format jsonb,
  -- [{"name", "size"}]: what went with the email. The files themselves are not kept.
  add column attachments jsonb not null default '[]'::jsonb
    check (jsonb_typeof(attachments) = 'array' and jsonb_array_length(attachments) <= 10);

-- ---------------------------------------------------------------------------
-- Read marks: each person's own
-- ---------------------------------------------------------------------------

create table public.ticket_reads (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  ticket_id uuid not null references public.tickets (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (ticket_id, user_id)
);
create index ticket_reads_user_idx on public.ticket_reads (user_id, tenant_id);

-- What is here today has been seen: nobody starts with a wall of dots.
insert into public.ticket_reads (tenant_id, ticket_id, user_id)
select t.tenant_id, t.id, m.user_id
from public.tickets t
join public.memberships m on m.tenant_id = t.tenant_id;

-- ---------------------------------------------------------------------------
-- What happened to a conversation. Written only by the trigger below and by
-- record_outbound (a forward); it holds what no other table says.
-- ---------------------------------------------------------------------------

create table public.ticket_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  ticket_id uuid not null references public.tickets (id) on delete cascade,
  -- Null when nobody was signed in: a customer's email, a rule, the worker.
  actor_id uuid references auth.users (id) on delete set null,
  kind text not null check (kind in
    ('status', 'assigned', 'priority', 'snoozed', 'unsnoozed', 'folder', 'subject', 'merged', 'forwarded')),
  detail text not null default '' check (char_length(detail) <= 300),
  created_at timestamptz not null default now()
);
create index ticket_events_ticket_idx on public.ticket_events (ticket_id, created_at);

do $$
declare
  t text;
begin
  foreach t in array array['ticket_folders', 'ticket_events', 'ticket_reads']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on public.%I to authenticated, service_role', t);
  end loop;
end;
$$;
create policy "members read their ticket folders" on public.ticket_folders
  for select to authenticated using (tenant_id in (select private.user_tenant_ids()));
create policy "members read their ticket events" on public.ticket_events
  for select to authenticated using (tenant_id in (select private.user_tenant_ids()));
create policy "people read their own read marks" on public.ticket_reads
  for select to authenticated
  using (user_id = (select auth.uid()) and tenant_id in (select private.user_tenant_ids()));

create function private.log_ticket_event()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
begin
  if new.status is distinct from old.status then
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
revoke all on function private.log_ticket_event() from public;
create trigger tickets_log_event
  after update on public.tickets
  for each row execute function private.log_ticket_event();

-- ---------------------------------------------------------------------------
-- Folders: owners and admins make them, anyone files a conversation
-- ---------------------------------------------------------------------------

create function public.create_ticket_folder(p_tenant_id uuid, p_name text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_manager(p_tenant_id);
  if (select count(*) from public.ticket_folders f where f.tenant_id = p_tenant_id) >= 40 then
    raise exception 'Forty folders is the most a workspace can have' using errcode = '22023';
  end if;
  insert into public.ticket_folders (tenant_id, name, created_by)
  values (p_tenant_id, btrim(p_name), auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

create function public.rename_ticket_folder(p_folder_id uuid, p_name text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  select f.tenant_id into v_tenant from public.ticket_folders f
  where f.id = p_folder_id and f.tenant_id in (select private.user_tenant_ids());
  if v_tenant is null then
    raise exception 'Folder not found' using errcode = 'P0002';
  end if;
  perform private.require_manager(v_tenant);
  update public.ticket_folders f set name = btrim(p_name) where f.id = p_folder_id;
end;
$$;

-- Removing a folder puts what was in it back in the inbox.
create function public.delete_ticket_folder(p_folder_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  select f.tenant_id into v_tenant from public.ticket_folders f
  where f.id = p_folder_id and f.tenant_id in (select private.user_tenant_ids());
  if v_tenant is null then
    raise exception 'Folder not found' using errcode = 'P0002';
  end if;
  perform private.require_manager(v_tenant);
  update public.tickets t set folder_id = null where t.folder_id = p_folder_id;
  delete from public.ticket_folders f where f.id = p_folder_id;
end;
$$;

-- Files a conversation in a folder of its own workspace (null: back to the inbox).
create function public.file_ticket(p_ticket_id uuid, p_folder_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_ticket public.tickets := private.member_ticket(p_ticket_id);
begin
  if p_folder_id is not null and not exists (
    select 1 from public.ticket_folders f
    where f.id = p_folder_id and f.tenant_id = v_ticket.tenant_id
  ) then
    raise exception 'Folder not found' using errcode = 'P0002';
  end if;
  update public.tickets t set folder_id = p_folder_id where t.id = v_ticket.id;
end;
$$;

create function public.set_ticket_subject(p_ticket_id uuid, p_subject text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_ticket public.tickets := private.member_ticket(p_ticket_id);
begin
  if btrim(coalesce(p_subject, '')) = '' then
    raise exception 'A conversation needs a subject' using errcode = '22023';
  end if;
  update public.tickets t set subject = left(btrim(p_subject), 200) where t.id = v_ticket.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Read marks
-- ---------------------------------------------------------------------------

create function public.mark_ticket_read(p_ticket_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  select t.tenant_id into v_tenant from public.tickets t
  where t.id = p_ticket_id and t.tenant_id in (select private.user_tenant_ids());
  if v_tenant is null then
    raise exception 'Ticket not found' using errcode = 'P0002';
  end if;
  insert into public.ticket_reads (tenant_id, ticket_id, user_id)
  values (v_tenant, p_ticket_id, auth.uid())
  on conflict (ticket_id, user_id) do update set read_at = now();
end;
$$;

create function public.mark_ticket_unread(p_ticket_id uuid)
returns void
language sql security definer set search_path = ''
as $$
  delete from public.ticket_reads r
  where r.ticket_id = p_ticket_id and r.user_id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- What the list shows beside each conversation, and searching what was said.
-- Both run as the person asking, so row-level security decides what they see.
-- ---------------------------------------------------------------------------

create function public.ticket_list_facts(p_ticket_ids uuid[])
returns table (
  ticket_id uuid, message_count int, preview text, last_direction text, last_inbound_at timestamptz
)
language sql stable security invoker set search_path = ''
as $$
  select t.id,
         (select count(*)::int from public.messages m where m.ticket_id = t.id),
         l.preview,
         l.direction,
         (select max(m.created_at) from public.messages m
          where m.ticket_id = t.id and m.direction = 'inbound')
  from public.tickets t
  left join lateral (
    select left(regexp_replace(left(m.body, 600), '\s+', ' ', 'g'), 220) as preview, m.direction
    from public.messages m where m.ticket_id = t.id
    order by m.created_at desc limit 1
  ) l on true
  where t.id = any (p_ticket_ids);
$$;

create function public.search_ticket_messages(p_tenant_id uuid, p_q text)
returns setof uuid
language sql stable security invoker set search_path = ''
as $$
  select distinct found.ticket_id from (
    select m.ticket_id from public.messages m
    where m.tenant_id = p_tenant_id and char_length(btrim(p_q)) >= 3
      and position(lower(btrim(p_q)) in lower(m.body)) > 0
    union all
    select n.ticket_id from public.ticket_notes n
    where n.tenant_id = p_tenant_id and char_length(btrim(p_q)) >= 3
      and position(lower(btrim(p_q)) in lower(n.body)) > 0
  ) found
  limit 300;
$$;

-- ---------------------------------------------------------------------------
-- Mail going out
-- ---------------------------------------------------------------------------

-- Records what a teammate sent: a reply or a forward, who it went to, and
-- what should happen to the conversation next. The app sends the email first
-- and passes the provider's id, so a retried request can't store it twice.
--   p_then: pending (in progress) | open | closed | snoozed | keep
create function public.record_outbound(
  p_ticket_id uuid,
  p_body text,
  p_from_email text,
  p_provider_message_id text,
  p_kind text default 'reply',
  p_to text[] default '{}',
  p_cc text[] default '{}',
  p_format jsonb default null,
  p_attachments jsonb default '[]'::jsonb,
  p_then text default 'pending',
  p_snooze_until timestamptz default null
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_ticket public.tickets := private.member_ticket(p_ticket_id);
  v_id uuid;
begin
  if btrim(coalesce(p_body, '')) = '' then
    raise exception 'An email needs some words in it' using errcode = '22023';
  end if;
  if p_kind not in ('reply', 'forward') or p_then not in ('pending', 'open', 'closed', 'snoozed', 'keep') then
    raise exception 'Unknown kind of send' using errcode = '22023';
  end if;
  if p_then = 'snoozed' and (p_snooze_until is null or p_snooze_until <= now()
                             or p_snooze_until > now() + interval '366 days') then
    raise exception 'Pick a time in the coming year' using errcode = '22023';
  end if;
  if coalesce(array_length(p_to, 1), 0) + coalesce(array_length(p_cc, 1), 0) > 20
     or (p_format is not null and pg_column_size(p_format) > 200000) then
    raise exception 'That email is too big to record' using errcode = '22023';
  end if;

  insert into public.messages
    (tenant_id, ticket_id, direction, from_email, body, provider_message_id, author_id,
     kind, to_emails, cc_emails, format, attachments)
  values
    (v_ticket.tenant_id, v_ticket.id, 'outbound', lower(p_from_email), p_body,
     p_provider_message_id, auth.uid(), p_kind,
     coalesce((select array_agg(lower(btrim(e))) from unnest(p_to) as e), '{}'),
     coalesce((select array_agg(lower(btrim(e))) from unnest(p_cc) as e), '{}'),
     p_format, coalesce(p_attachments, '[]'::jsonb))
  on conflict (tenant_id, provider_message_id) do nothing
  returning id into v_id;
  if v_id is null then
    return null;
  end if;

  update public.tickets t
  set last_message_at = now(),
      status = case p_then when 'pending' then 'pending'::public.ticket_status
                           when 'snoozed' then 'pending'::public.ticket_status
                           when 'open' then 'open'::public.ticket_status
                           when 'closed' then 'closed'::public.ticket_status
                           else t.status end,
      closed_at = case when p_then = 'closed' then coalesce(t.closed_at, now())
                       when p_then = 'keep' then t.closed_at end,
      snoozed_until = case when p_then = 'snoozed' then p_snooze_until
                           when p_then = 'keep' then t.snoozed_until end,
      first_reply_at = case when p_kind = 'reply' then coalesce(t.first_reply_at, now())
                            else t.first_reply_at end,
      assignee_id = case when p_kind = 'reply' then coalesce(t.assignee_id, auth.uid())
                         else t.assignee_id end
  where t.id = v_ticket.id;

  if p_kind = 'forward' then
    insert into public.ticket_events (tenant_id, ticket_id, actor_id, kind, detail)
    values (v_ticket.tenant_id, v_ticket.id, auth.uid(), 'forwarded',
            left(array_to_string(p_to, ', '), 300));
  end if;
  return v_id;
end;
$$;

-- A conversation the team starts. It belongs to whoever started it.
create function public.start_ticket(p_tenant_id uuid, p_email text, p_name text, p_subject text)
returns table (id uuid, number int)
language plpgsql security definer set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_contact uuid;
  v_ticket public.tickets;
begin
  if not private.is_member(p_tenant_id, auth.uid()) then
    raise exception 'Workspace not found' using errcode = 'P0002';
  end if;
  if v_email !~ '^[^@\s<>",;]+@[^@\s<>",;]+\.[^@\s<>",;]+$' or char_length(v_email) > 254 then
    raise exception 'That email address does not look right' using errcode = '22023';
  end if;
  if btrim(coalesce(p_subject, '')) = '' then
    raise exception 'A conversation needs a subject' using errcode = '22023';
  end if;
  -- The same lock incoming email takes, so numbers stay in order.
  perform 1 from public.tenants t where t.id = p_tenant_id for update;
  insert into public.contacts (tenant_id, email, name)
  values (p_tenant_id, v_email, nullif(btrim(coalesce(p_name, '')), ''))
  on conflict (tenant_id, email) do update
    set name = coalesce(public.contacts.name, excluded.name)
  returning contacts.id into v_contact;
  insert into public.tickets (tenant_id, number, contact_id, subject, reply_key, assignee_id)
  values (
    p_tenant_id,
    (select coalesce(max(t.number), 0) + 1 from public.tickets t where t.tenant_id = p_tenant_id),
    v_contact, left(btrim(p_subject), 200), replace(gen_random_uuid()::text, '-', ''), auth.uid())
  returning * into v_ticket;
  insert into public.ticket_reads (tenant_id, ticket_id, user_id)
  values (p_tenant_id, v_ticket.id, auth.uid());
  return query select v_ticket.id, v_ticket.number;
end;
$$;

-- The summary a person asked Claude for. It is the team's own aid; nothing
-- here is ever sent to the customer.
create function public.set_ticket_insights(p_ticket_id uuid, p_summary text, p_mood text, p_kind text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_ticket public.tickets := private.member_ticket(p_ticket_id);
begin
  update public.tickets t
  set ai_summary = left(btrim(p_summary), 1200),
      ai_mood = case when p_mood in ('positive', 'neutral', 'negative') then p_mood end,
      ai_kind = nullif(left(btrim(coalesce(p_kind, '')), 40), ''),
      ai_updated_at = now()
  where t.id = v_ticket.id;
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.create_ticket_folder(uuid, text)',
    'public.rename_ticket_folder(uuid, text)',
    'public.delete_ticket_folder(uuid)',
    'public.file_ticket(uuid, uuid)',
    'public.set_ticket_subject(uuid, text)',
    'public.mark_ticket_read(uuid)',
    'public.mark_ticket_unread(uuid)',
    'public.ticket_list_facts(uuid[])',
    'public.search_ticket_messages(uuid, text)',
    'public.record_outbound(uuid, text, text, text, text, text[], text[], jsonb, jsonb, text, timestamptz)',
    'public.start_ticket(uuid, text, text, text)',
    'public.set_ticket_insights(uuid, text, text, text)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;
