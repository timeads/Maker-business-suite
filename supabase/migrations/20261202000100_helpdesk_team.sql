-- Help desk, second pass: working an inbox as a team.
-- Who has a conversation, how urgent it is, putting it aside until later,
-- notes only the team sees, folding two conversations into one, and the
-- numbers behind the "how are we doing" page.

alter table public.tickets
  add column assignee_id uuid references auth.users (id) on delete set null,
  add column priority text not null default 'normal'
    check (priority in ('low', 'normal', 'high', 'urgent')),
  -- Out of the way until this time, or until the customer writes again.
  add column snoozed_until timestamptz,
  -- Set on a conversation that was folded into another one.
  add column merged_into uuid references public.tickets (id) on delete set null,
  add column first_reply_at timestamptz,
  add column closed_at timestamptz;
create index tickets_tenant_assignee_idx on public.tickets (tenant_id, assignee_id);

grant select (assignee_id, priority, snoozed_until, merged_into, first_reply_at, closed_at)
  on public.tickets to authenticated;

-- Notes the team leaves for each other. Never sent to the customer.
create table public.ticket_notes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  ticket_id uuid not null references public.tickets (id) on delete cascade,
  author_id uuid references auth.users (id) on delete set null,
  body text not null check (char_length(body) between 1 and 4000),
  mentions uuid[] not null default '{}',
  created_at timestamptz not null default now()
);
create index ticket_notes_ticket_idx on public.ticket_notes (ticket_id, created_at);
alter table public.ticket_notes enable row level security;
create policy "members read their ticket notes" on public.ticket_notes
  for select to authenticated using (tenant_id in (select private.user_tenant_ids()));
revoke all on public.ticket_notes from public, anon, authenticated, service_role;
grant select on public.ticket_notes to authenticated, service_role;

create function private.is_member(p_tenant_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m where m.tenant_id = p_tenant_id and m.user_id = p_user_id);
$$;
revoke all on function private.is_member(uuid, uuid) from public;

-- ---------------------------------------------------------------------------
-- Inbound email: a customer writing back wakes a snoozed conversation, and
-- mail for a conversation that was folded into another follows it there.
-- ---------------------------------------------------------------------------

create or replace function public.ingest_inbound_email(
  p_slug text,
  p_provider_message_id text,
  p_from_email text,
  p_from_name text,
  p_subject text,
  p_body text,
  p_message_id text default null,
  p_reply_key text default null,
  p_references text[] default '{}',
  p_tags text[] default '{}'
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
begin
  -- Locking the workspace row keeps ticket numbers gap-free and in order.
  select t.id into v_tenant_id from public.tenants t where t.slug = p_slug for update;
  if v_tenant_id is null then
    return jsonb_build_object('result', 'unknown_workspace');
  end if;
  if v_email = '' then
    raise exception 'Inbound email has no sender';
  end if;
  if exists (
    select 1 from public.messages m
    where m.tenant_id = v_tenant_id and m.provider_message_id = p_provider_message_id
  ) then
    return jsonb_build_object('result', 'duplicate');
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
  else
    -- A customer writing back reopens the conversation and wakes it.
    update public.tickets t
    set status = 'open', last_message_at = now(), snoozed_until = null, closed_at = null
    where t.id = v_ticket.id;
  end if;

  insert into public.messages
    (tenant_id, ticket_id, direction, from_email, from_name, body, message_id, provider_message_id)
  values
    (v_tenant_id, v_ticket.id, 'inbound', v_email, nullif(btrim(coalesce(p_from_name, '')), ''),
     coalesce(p_body, ''), p_message_id, p_provider_message_id);

  perform private.add_ticket_tags(v_tenant_id, v_ticket.id, p_tags);

  return jsonb_build_object(
    'result', case when v_created then 'created' else 'threaded' end,
    'tenant_id', v_tenant_id,
    'ticket_id', v_ticket.id,
    'number', v_ticket.number
  );
end;
$$;

-- What the workspace's rules decided for a brand-new conversation (service
-- role, from the worker). Someone who has left the workspace is ignored.
create function public.apply_ticket_rules(
  p_tenant_id uuid, p_ticket_id uuid, p_priority text default null, p_assignee_id uuid default null
)
returns void
language sql security definer set search_path = ''
as $$
  update public.tickets t
  set priority = case when p_priority in ('low', 'normal', 'high', 'urgent')
                      then p_priority else t.priority end,
      assignee_id = case when p_assignee_id is not null
                              and private.is_member(p_tenant_id, p_assignee_id)
                         then p_assignee_id else t.assignee_id end
  where t.id = p_ticket_id and t.tenant_id = p_tenant_id;
$$;
revoke all on function public.apply_ticket_rules(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.apply_ticket_rules(uuid, uuid, text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- What members do
-- ---------------------------------------------------------------------------

-- A reply also stamps the first-response time, wakes the conversation, and
-- hands it to whoever answered if nobody had it.
create or replace function public.record_reply(
  p_ticket_id uuid,
  p_body text,
  p_from_email text,
  p_provider_message_id text,
  p_message_id text default null
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_ticket public.tickets := private.member_ticket(p_ticket_id);
  v_id uuid;
begin
  if btrim(coalesce(p_body, '')) = '' then
    raise exception 'A reply needs some words in it' using errcode = '22023';
  end if;
  insert into public.messages
    (tenant_id, ticket_id, direction, from_email, body, message_id, provider_message_id, author_id)
  values
    (v_ticket.tenant_id, v_ticket.id, 'outbound', lower(p_from_email), p_body, p_message_id,
     p_provider_message_id, auth.uid())
  on conflict (tenant_id, provider_message_id) do nothing
  returning id into v_id;

  update public.tickets t
  set status = 'pending', last_message_at = now(), snoozed_until = null,
      first_reply_at = coalesce(t.first_reply_at, now()),
      assignee_id = coalesce(t.assignee_id, auth.uid())
  where t.id = v_ticket.id;
  return v_id;
end;
$$;

create or replace function public.set_ticket_status(p_ticket_id uuid, p_status public.ticket_status)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_ticket public.tickets := private.member_ticket(p_ticket_id);
begin
  update public.tickets t
  set status = p_status,
      closed_at = case when p_status = 'closed' then coalesce(t.closed_at, now()) end,
      snoozed_until = case when p_status = 'closed' then null else t.snoozed_until end
  where t.id = v_ticket.id;
end;
$$;

-- Hands a conversation to a teammate, or to nobody.
create function public.assign_ticket(p_ticket_id uuid, p_user_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_ticket public.tickets := private.member_ticket(p_ticket_id);
begin
  if p_user_id is not null and not private.is_member(v_ticket.tenant_id, p_user_id) then
    raise exception 'That person is not in this workspace' using errcode = 'P0002';
  end if;
  update public.tickets t set assignee_id = p_user_id where t.id = v_ticket.id;
end;
$$;

create function public.set_ticket_priority(p_ticket_id uuid, p_priority text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_ticket public.tickets := private.member_ticket(p_ticket_id);
begin
  update public.tickets t set priority = p_priority where t.id = v_ticket.id;
end;
$$;

-- Puts a conversation aside until a time (null brings it straight back).
create function public.snooze_ticket(p_ticket_id uuid, p_until timestamptz)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_ticket public.tickets := private.member_ticket(p_ticket_id);
begin
  if p_until is not null and (p_until <= now() or p_until > now() + interval '366 days') then
    raise exception 'Pick a time in the coming year' using errcode = '22023';
  end if;
  update public.tickets t set snoozed_until = p_until where t.id = v_ticket.id;
end;
$$;

create function public.add_ticket_note(p_ticket_id uuid, p_body text, p_mentions uuid[] default '{}')
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_ticket public.tickets := private.member_ticket(p_ticket_id);
  v_id uuid;
begin
  if btrim(coalesce(p_body, '')) = '' then
    raise exception 'A note needs some words in it' using errcode = '22023';
  end if;
  insert into public.ticket_notes (tenant_id, ticket_id, author_id, body, mentions)
  values (v_ticket.tenant_id, v_ticket.id, auth.uid(), btrim(p_body),
          coalesce((select array_agg(distinct u) from unnest(coalesce(p_mentions, '{}')) as u
                    where private.is_member(v_ticket.tenant_id, u)), '{}'))
  returning id into v_id;
  return v_id;
end;
$$;

-- Folds one conversation into another from the same workspace: its emails,
-- notes and tags move across and it closes, pointing at where it went.
create function public.merge_tickets(p_from_ticket_id uuid, p_into_ticket_id uuid)
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
     or v_into.merged_into is not null then
    raise exception 'Those two can''t be joined' using errcode = '22023';
  end if;
  update public.messages m set ticket_id = v_into.id where m.ticket_id = v_from.id;
  update public.ticket_notes n set ticket_id = v_into.id where n.ticket_id = v_from.id;
  insert into public.ticket_tags (tenant_id, ticket_id, tag_id)
  select tt.tenant_id, v_into.id, tt.tag_id from public.ticket_tags tt where tt.ticket_id = v_from.id
  on conflict do nothing;
  update public.tickets t
  set merged_into = v_into.id, status = 'closed', closed_at = coalesce(t.closed_at, now()),
      snoozed_until = null
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

revoke all on function public.assign_ticket(uuid, uuid) from public, anon;
revoke all on function public.set_ticket_priority(uuid, text) from public, anon;
revoke all on function public.snooze_ticket(uuid, timestamptz) from public, anon;
revoke all on function public.add_ticket_note(uuid, text, uuid[]) from public, anon;
revoke all on function public.merge_tickets(uuid, uuid) from public, anon;
grant execute on function public.assign_ticket(uuid, uuid) to authenticated;
grant execute on function public.set_ticket_priority(uuid, text) to authenticated;
grant execute on function public.snooze_ticket(uuid, timestamptz) to authenticated;
grant execute on function public.add_ticket_note(uuid, text, uuid[]) to authenticated;
grant execute on function public.merge_tickets(uuid, uuid) to authenticated;
