-- Help desk: an automatic first reply.
--
-- When someone writes in (an Instagram or Facebook message, or an email) the
-- help desk can answer once by itself with words an owner or admin wrote
-- (`configs`, helpdesk / auto_replies). FIXED WORDS ONLY: nothing here, and
-- nothing on the path that leads here, asks a model for anything.
--
-- It goes through the outbox every reply uses, with no undo wait and no
-- author. What this file holds:
--  - `messages.automatic`: the reply as it is filed, belonging to no person.
--    It never counts as the team having answered: the conversation's status,
--    `first_reply_at`, assignee and the list's "last message" are left alone.
--  - `private.auto_replies`: the claim. One row per inbound message, taken
--    under the conversation's lock, so two workers or a retry can't send
--    twice; it is also the record the quiet period is read from.
--  - the outbox learns to carry a reply with no author, and its two
--    "write down how it went" functions file such a reply as automatic.
--    A refusal is kept as failed and is never tried again.

-- ---------------------------------------------------------------------------
-- The reply as filed
-- ---------------------------------------------------------------------------

alter table public.messages
  add column automatic boolean not null default false,
  -- An automatic reply is the business's own, written by nobody in particular.
  add constraint messages_automatic_shape
    check (not automatic or (direction = 'outbound' and author_id is null));

-- ---------------------------------------------------------------------------
-- The outbox carries a reply with no author
-- ---------------------------------------------------------------------------

alter table private.outbound_queue
  alter column author_id drop not null,
  add column automatic boolean not null default false,
  add constraint outbound_queue_author_shape check (automatic = (author_id is null));

-- ---------------------------------------------------------------------------
-- The claim, and the record the quiet period is read from
-- ---------------------------------------------------------------------------

create table private.auto_replies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  ticket_id uuid not null references public.tickets (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  channel text not null check (channel in ('email', 'instagram', 'facebook')),
  -- The message being answered. One automatic reply per message, ever.
  inbound_message_id uuid not null unique references public.messages (id) on delete cascade,
  queue_id uuid references private.outbound_queue (id) on delete set null,
  -- Which of the two saved messages: the usual one, or the away one.
  variant text not null check (variant in ('usual', 'away')),
  state text not null default 'queued' check (state in ('queued', 'sent', 'failed')),
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index auto_replies_person_idx
  on private.auto_replies (tenant_id, contact_id, channel, created_at desc);
create index auto_replies_queue_idx on private.auto_replies (queue_id);
alter table private.auto_replies enable row level security;
revoke all on private.auto_replies from public, anon, authenticated, service_role;

-- What the worker needs to decide, for one filed message (service role).
create function public.auto_reply_facts(p_tenant_id uuid, p_message_id uuid)
returns table (
  channel text, ticket_id uuid, ticket_kind text, shelf text, direction text,
  message_kind text, removed boolean, received_at timestamptz,
  contact_name text, reply_to_email text, last_auto_reply_at timestamptz,
  team_answered_since boolean, business_name text, time_zone text
)
language sql stable security definer set search_path = ''
as $$
  select t.channel, t.id, t.kind, t.shelf, m.direction, m.kind,
         m.removed_at is not null,
         coalesce(m.sent_at, m.created_at),
         c.name,
         -- An email is answered to whoever sent it.
         coalesce(m.from_email, c.email),
         (select max(a.created_at) from private.auto_replies a
          where a.tenant_id = t.tenant_id and a.contact_id = t.contact_id
            and a.channel = t.channel),
         exists (select 1 from public.messages o
                 where o.ticket_id = t.id and o.direction = 'outbound' and not o.automatic
                   and o.created_at >= m.created_at)
           or exists (select 1 from private.outbound_queue q
                      where q.ticket_id = t.id and not q.automatic
                        and q.state in ('waiting', 'sending')),
         w.name, w.timezone
  from public.messages m
  join public.tickets t on t.id = m.ticket_id
  join public.contacts c on c.id = t.contact_id
  join public.tenants w on w.id = t.tenant_id
  where m.id = p_message_id and m.tenant_id = p_tenant_id and t.tenant_id = p_tenant_id
    and t.merged_into is null;
$$;

-- Takes the claim for one inbound message and puts the reply in the outbox,
-- due now. Everything that could have changed since the worker decided is
-- checked again here, under the conversation's and the person's locks:
-- that the message is a real one from a person, that the conversation isn't
-- in Spam or the Trash, that nobody on the team has answered since, and the
-- quiet period. Returns {"result": "queued" | "duplicate" | "not_a_message"
-- | "shelved" | "answered" | "quiet" | "unknown", "id": …}.
create function public.claim_auto_reply(
  p_tenant_id uuid,
  p_message_id uuid,
  p_variant text,
  p_payload jsonb,
  p_summary jsonb,
  p_quiet_hours int
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_message public.messages;
  v_ticket public.tickets;
  v_queue uuid;
begin
  if p_quiet_hours is null or p_quiet_hours < 1 or p_quiet_hours > 168 then
    raise exception 'The quiet period is between 1 and 168 hours' using errcode = '22023';
  end if;
  if p_variant not in ('usual', 'away') then
    raise exception 'Unknown kind of automatic reply' using errcode = '22023';
  end if;
  if jsonb_typeof(p_payload) is distinct from 'object' or pg_column_size(p_payload) > 20000 then
    raise exception 'That automatic reply can''t be queued' using errcode = '22023';
  end if;

  select * into v_message from public.messages m
  where m.id = p_message_id and m.tenant_id = p_tenant_id;
  if not found then
    return jsonb_build_object('result', 'unknown');
  end if;
  -- One at a time per person, so two messages on two conversations can't both
  -- pass the quiet period. The person first, then the conversation: the same
  -- order filing a message takes them in, so the two never wait on each other.
  perform 1 from public.contacts c
  where c.id = (select t.contact_id from public.tickets t
                where t.id = v_message.ticket_id and t.tenant_id = p_tenant_id)
  for update;
  select * into v_ticket from public.tickets t
  where t.id = v_message.ticket_id and t.tenant_id = p_tenant_id
  for update;
  if not found then
    return jsonb_build_object('result', 'unknown');
  end if;

  if exists (select 1 from private.auto_replies a where a.inbound_message_id = p_message_id) then
    return jsonb_build_object('result', 'duplicate');
  end if;
  if v_message.direction <> 'inbound' or v_message.removed_at is not null
     or v_message.kind not in ('reply', 'story_reply', 'share')
     or v_ticket.kind <> 'message' or v_ticket.merged_into is not null then
    return jsonb_build_object('result', 'not_a_message');
  end if;
  if v_ticket.shelf in ('spam', 'trash') then
    return jsonb_build_object('result', 'shelved');
  end if;
  if exists (select 1 from public.messages o
             where o.ticket_id = v_ticket.id and o.direction = 'outbound' and not o.automatic
               and o.created_at >= v_message.created_at)
     or exists (select 1 from private.outbound_queue q
                where q.ticket_id = v_ticket.id and not q.automatic
                  and q.state in ('waiting', 'sending')) then
    return jsonb_build_object('result', 'answered');
  end if;
  -- Any claim counts, whether or not it went: a refused reply is not tried
  -- again on the person's next message either.
  if exists (select 1 from private.auto_replies a
             where a.tenant_id = p_tenant_id and a.contact_id = v_ticket.contact_id
               and a.channel = v_ticket.channel
               and a.created_at > now() - make_interval(hours => p_quiet_hours)) then
    return jsonb_build_object('result', 'quiet');
  end if;

  insert into private.outbound_queue
    (tenant_id, ticket_id, author_id, automatic, payload, summary, send_at)
  values
    (p_tenant_id, v_ticket.id, null, true,
     p_payload || jsonb_build_object('automatic', true),
     coalesce(p_summary, '{}'::jsonb) || jsonb_build_object('automatic', true),
     now())
  returning id into v_queue;
  insert into private.auto_replies
    (tenant_id, ticket_id, contact_id, channel, inbound_message_id, queue_id, variant)
  values
    (p_tenant_id, v_ticket.id, v_ticket.contact_id, v_ticket.channel, p_message_id, v_queue,
     p_variant);
  return jsonb_build_object('result', 'queued', 'id', v_queue);
end;
$$;

-- Files an automatic reply that has gone. It belongs to no person, and it is
-- not the team answering: the conversation's status, first reply time,
-- assignee and place in the list are all left as they were.
create function private.record_auto_reply(
  p_row private.outbound_queue,
  p_body text,
  p_provider_message_id text,
  p_from_email text
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.messages
    (tenant_id, ticket_id, direction, from_email, from_name, body, provider_message_id,
     author_id, automatic, kind, to_emails, sent_at)
  values
    (p_row.tenant_id, p_row.ticket_id, 'outbound', lower(p_from_email), 'Automatic reply',
     left(coalesce(p_body, ''), 8000), p_provider_message_id, null, true, 'reply',
     coalesce(array(select lower(btrim(e))
                    from jsonb_array_elements_text(
                      case when jsonb_typeof(p_row.payload -> 'to') = 'array'
                           then p_row.payload -> 'to' else '[]'::jsonb end) as e), '{}'),
     now())
  on conflict (tenant_id, provider_message_id) do nothing
  returning id into v_id;
  update private.auto_replies a
  set state = 'sent', finished_at = now()
  where a.queue_id = p_row.id;
  return v_id;
end;
$$;
revoke all on function private.record_auto_reply(private.outbound_queue, text, text, text)
  from public, anon, authenticated;

-- A member's own reply can't pass itself off as automatic.
create or replace function public.queue_outbound(
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
  values (v_ticket.tenant_id, v_ticket.id, auth.uid(), p_payload - 'automatic',
          coalesce(p_summary, '{}'::jsonb) - 'automatic',
          now() + make_interval(secs => p_delay_seconds))
  returning id into v_id;
  return v_id;
end;
$$;

-- The worker's turn. As before, with one change: an automatic reply has no
-- author, so "its author has left" is never asked of it.
create or replace function public.claim_outbound(p_limit int default 5)
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
  where q.state = 'waiting' and q.send_at <= now() and not q.automatic
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

-- How an email went. As before for a person's email; an automatic reply is
-- filed as automatic, and a refusal is written down once, on the outbox row
-- and on the claim, with nothing kept to send again.
create or replace function public.finish_outbound(
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

  if v_row.automatic then
    if p_error is not null or p_provider_message_id is null then
      update private.outbound_queue q
      set state = 'failed', error = left(coalesce(p_error, 'unknown'), 200),
          payload = '{}'::jsonb, finished_at = now()
      where q.id = p_id;
      update private.auto_replies a
      set state = 'failed', error = left(coalesce(p_error, 'unknown'), 200), finished_at = now()
      where a.queue_id = p_id;
      return null;
    end if;
    begin
      v_message := private.record_auto_reply(v_row, p_body, p_provider_message_id, p_from_email);
    exception when others then
      update private.outbound_queue q
      set state = 'unsure', error = 'sent_not_filed', payload = '{}'::jsonb, finished_at = now()
      where q.id = p_id;
      return null;
    end;
    update private.outbound_queue q
    set state = 'sent', payload = '{}'::jsonb, finished_at = now()
    where q.id = p_id;
    return v_message;
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

-- The same for an Instagram or Facebook message.
create or replace function public.finish_social_outbound(
  p_id uuid,
  p_mids text[] default '{}',
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

  if v_row.automatic then
    if coalesce(array_length(p_mids, 1), 0) = 0 then
      -- Meta said no (another tool has the conversation, say), or we stopped
      -- before asking. Written down once; nothing is kept to send again.
      update private.outbound_queue q
      set state = 'failed', error = left(coalesce(p_error, 'unknown'), 200),
          payload = '{}'::jsonb, finished_at = now()
      where q.id = p_id;
      update private.auto_replies a
      set state = 'failed', error = left(coalesce(p_error, 'unknown'), 200), finished_at = now()
      where a.queue_id = p_id;
      return null;
    end if;
    begin
      v_message := private.record_auto_reply(v_row, p_body, p_mids[1], null);
    exception when others then
      update private.outbound_queue q
      set state = 'unsure', error = 'sent_not_filed', payload = '{}'::jsonb, finished_at = now()
      where q.id = p_id;
      return null;
    end;
    update private.outbound_queue q
    set state = 'sent', payload = '{}'::jsonb, finished_at = now()
    where q.id = p_id;
    return v_message;
  end if;

  if coalesce(array_length(p_mids, 1), 0) = 0 then
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
    -- From here on this transaction acts as the person who wrote the reply.
    perform set_config('request.jwt.claims',
      jsonb_build_object('sub', v_row.author_id, 'role', 'authenticated')::text, true);
    v_message := public.record_social_outbound(
      v_row.ticket_id, p_body, p_mids, coalesce(p_attachments, '[]'::jsonb), v_then, v_until);
    perform public.apply_send_actions(
      v_row.ticket_id,
      array(select jsonb_array_elements_text(coalesce(v_row.payload -> 'add_tags', '[]'::jsonb))),
      (v_row.payload ->> 'assign_to')::uuid);
    insert into public.ticket_reads (tenant_id, ticket_id, user_id)
    values (v_row.tenant_id, v_row.ticket_id, v_row.author_id)
    on conflict (ticket_id, user_id) do update set read_at = now();
  exception when others then
    -- The message has gone; only the filing failed. Say so rather than lose it.
    update private.outbound_queue q
    set state = 'unsure', error = 'sent_not_filed', payload = '{}'::jsonb, finished_at = now()
    where q.id = p_id;
    return null;
  end;
  update private.outbound_queue q
  set state = case when p_error is null then 'sent' else 'failed' end,
      error = left(p_error, 200), payload = '{}'::jsonb, finished_at = now()
  where q.id = p_id;
  return v_message;
end;
$$;

-- ---------------------------------------------------------------------------
-- The list: an automatic reply is not "the last thing said". The preview and
-- the last direction stay the customer's, so a conversation that only got
-- the automatic reply still reads as waiting for a person.
-- ---------------------------------------------------------------------------

create or replace function public.ticket_list_facts(p_ticket_ids uuid[])
returns table (
  ticket_id uuid, message_count int, preview text, last_direction text, last_inbound_at timestamptz
)
language sql stable security invoker set search_path = ''
as $$
  select t.id,
         (select count(*)::int from public.messages m
          where m.ticket_id = t.id and m.kind <> 'reaction'),
         l.preview,
         l.direction,
         (select max(m.created_at) from public.messages m
          where m.ticket_id = t.id and m.direction = 'inbound' and m.kind <> 'reaction')
  from public.tickets t
  left join lateral (
    select case
             when m.removed_at is not null and m.kind = 'comment' then 'Comment removed'
             when m.removed_at is not null then 'Message removed'
             when btrim(m.body) = '' then coalesce(m.summary, '')
             else left(regexp_replace(left(m.body, 600), '\s+', ' ', 'g'), 220)
           end as preview,
           m.direction
    from public.messages m
    where m.ticket_id = t.id and m.kind <> 'reaction' and not m.automatic
    order by m.created_at desc limit 1
  ) l on true
  where t.id = any (p_ticket_ids);
$$;

-- ---------------------------------------------------------------------------
-- Who may call what
-- ---------------------------------------------------------------------------

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.auto_reply_facts(uuid, uuid)',
    'public.claim_auto_reply(uuid, uuid, text, jsonb, jsonb, int)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
