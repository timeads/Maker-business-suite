-- Help desk, seventh pass: Instagram and Facebook messages.
-- A conversation can now come from somewhere other than email. Messages
-- arrive through the workspace's Meta connection (the one Social posts
-- with), only once a manager has switched them on and Facebook has granted
-- the messaging permissions. Meta's webhook is verified and queued by the
-- web service; the worker files it. One conversation per person per channel;
-- replies go out through the help desk's own outbox, within Meta's 24 hours.
-- Members read; every write is a function that checks who is asking.

-- ---------------------------------------------------------------------------
-- People without an email address, and where a conversation came from
-- ---------------------------------------------------------------------------

alter table public.contacts
  alter column email drop not null,
  add column channel text not null default 'email'
    check (channel in ('email', 'instagram', 'facebook')),
  -- The person's id as Meta scopes it to this Page or Instagram account.
  add column external_id text check (external_id is null or char_length(external_id) between 1 and 200),
  -- An Instagram username, without the "@". Read from Meta, never typed by the customer.
  add column handle text check (handle is null or handle ~ '^[A-Za-z0-9._]{1,30}$'),
  -- An email the team wrote down for someone who messaged, so their orders can be found.
  add column known_email text check (known_email is null or (known_email = lower(known_email)
    and char_length(known_email) <= 254)),
  add column profile_checked_at timestamptz,
  add constraint contacts_channel_shape check (
    (channel = 'email') = (email is not null) and (channel = 'email') = (external_id is null)
  );
create unique index contacts_social_person_idx
  on public.contacts (tenant_id, channel, external_id) where external_id is not null;

alter table public.tickets
  add column channel text not null default 'email'
    check (channel in ('email', 'instagram', 'facebook'));
create index tickets_tenant_channel_idx on public.tickets (tenant_id, channel, last_message_at desc)
  where channel <> 'email';
grant select (channel) on public.tickets to authenticated;

alter table public.messages
  alter column from_email drop not null,
  -- When Meta says it was sent. Meta's 24-hour reply window runs from this.
  add column sent_at timestamptz,
  -- A few words of ours for a message that isn't only text ("Sent a photo"). Never the customer's.
  add column summary text check (summary is null or char_length(summary) <= 120),
  -- Set when the customer took the message back: its words and files are gone.
  add column removed_at timestamptz,
  -- Meta's other ids for one reply (words and pictures go as two messages).
  add column also_ids text[] not null default '{}';
alter table public.messages drop constraint messages_kind_check;
alter table public.messages add constraint messages_kind_check check (kind in
  ('reply', 'forward', 'story_reply', 'story_mention', 'share', 'reaction'));

-- Two conversations from different channels can't be joined: a reply could
-- only go one way.
create function private.keep_channels_apart()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.merged_into is not null and new.merged_into is distinct from old.merged_into
     and new.channel is distinct from
         (select t.channel from public.tickets t where t.id = new.merged_into) then
    raise exception 'Conversations from different channels can''t be joined' using errcode = '22023';
  end if;
  if new.channel is distinct from old.channel then
    raise exception 'A conversation keeps the channel it came from' using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke all on function private.keep_channels_apart() from public;
create trigger tickets_keep_channels_apart
  before update on public.tickets
  for each row execute function private.keep_channels_apart();

-- ---------------------------------------------------------------------------
-- Voice messages: sound joins the kinds of file the help desk keeps
-- ---------------------------------------------------------------------------

update storage.buckets
set allowed_mime_types = array['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic',
  'application/pdf', 'video/mp4', 'video/quicktime',
  'audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/ogg', 'audio/wav', 'text/plain', 'text/csv']
where id = 'helpdesk';

do $$
declare
  v_name text;
begin
  select c.conname into v_name from pg_catalog.pg_constraint c
  where c.conrelid = 'public.message_attachments'::regclass and c.contype = 'c'
    and pg_catalog.pg_get_constraintdef(c.oid) like '%video/quicktime%';
  if v_name is null then
    raise exception 'The kept-types rule on message_attachments was not found';
  end if;
  execute format('alter table public.message_attachments drop constraint %I', v_name);
end;
$$;
alter table public.message_attachments add constraint message_attachments_kept_types check (
  state <> 'kept' or mime_type in
    ('image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic',
     'application/pdf', 'video/mp4', 'video/quicktime',
     'audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/ogg', 'audio/wav', 'text/plain', 'text/csv'));

-- ---------------------------------------------------------------------------
-- Which workspace an account belongs to. Only a live Meta connection that
-- was granted the messaging permissions, in a workspace that has switched
-- the channel on, counts. Anything else is dropped unread.
-- ---------------------------------------------------------------------------

create function private.meta_channel(p_object text, p_account_id text)
returns table (tenant_id uuid, connection_id uuid, channel text, page_id text)
language sql stable security definer set search_path = ''
as $$
  select c.tenant_id, c.id, w.channel, c.external_account_id
  from (select case p_object when 'instagram' then 'instagram' when 'page' then 'facebook' end as channel) w
  join public.connections c
    on c.provider = 'meta' and c.status = 'active'
   and c.scopes @> array['pages_manage_metadata']
   and case w.channel
         when 'facebook' then c.external_account_id = p_account_id
                              and c.scopes @> array['pages_messaging']
         when 'instagram' then c.metadata ->> 'instagram_id' = p_account_id
                               and c.scopes @> array['instagram_manage_messages', 'instagram_basic']
         else false
       end
  where p_account_id is not null and p_account_id <> ''
    and exists (
      select 1 from public.configs g
      where g.tenant_id = c.tenant_id and g.module = 'helpdesk' and g.key = 'channels'
        and jsonb_typeof(g.body -> w.channel) = 'boolean' and (g.body ->> w.channel)::boolean
    )
  limit 1;
$$;
revoke all on function private.meta_channel(text, text) from public;

-- For the worker: whose a delivery is. Service role only.
create function public.resolve_meta_channel(p_object text, p_account_id text)
returns table (tenant_id uuid, connection_id uuid, channel text, page_id text)
language sql stable security definer set search_path = ''
as $$
  select * from private.meta_channel(p_object, p_account_id);
$$;

-- ---------------------------------------------------------------------------
-- Meta's deliveries, verified by the web service and waiting for the worker.
-- Not tenant data yet: the workspace is worked out from the account when the
-- delivery is filed. A delivery for an account nobody has connected is never
-- stored.
-- ---------------------------------------------------------------------------

create table private.meta_events (
  -- A fingerprint of the delivery's own bytes: the same delivery twice is kept once.
  id text primary key check (char_length(id) between 16 and 128),
  payload jsonb not null,
  received_at timestamptz not null default now(),
  locked_at timestamptz,
  processed_at timestamptz,
  attempts int not null default 0,
  last_error text
);
create index meta_events_pending_idx on private.meta_events (received_at) where processed_at is null;
alter table private.meta_events enable row level security;
revoke all on private.meta_events from public, anon, authenticated, service_role;

-- Returns 'queued', 'duplicate' or 'dropped'.
create function public.enqueue_meta_event(p_id text, p_payload jsonb)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_inserted int;
begin
  if jsonb_typeof(p_payload -> 'entry') is distinct from 'array'
     or pg_column_size(p_payload) > 1000000 then
    return 'dropped';
  end if;
  if not exists (
    select 1 from jsonb_array_elements(p_payload -> 'entry') e
    where exists (select 1 from private.meta_channel(p_payload ->> 'object', e ->> 'id'))
  ) then
    return 'dropped';
  end if;
  insert into private.meta_events (id, payload) values (p_id, p_payload)
  on conflict (id) do nothing;
  get diagnostics v_inserted = row_count;
  return case when v_inserted = 1 then 'queued' else 'duplicate' end;
end;
$$;

create function public.claim_meta_events(p_limit int default 10)
returns table (id text, payload jsonb, attempts int)
language sql security definer set search_path = ''
as $$
  update private.meta_events e
  set locked_at = now(), attempts = e.attempts + 1
  where e.id in (
    select s.id from private.meta_events s
    where s.processed_at is null
      and s.attempts < 8
      -- A delivery that asked to be tried again waits a short while, not five minutes.
      and (s.locked_at is null or s.locked_at < now() - interval '1 minute')
    order by s.received_at
    limit greatest(1, least(coalesce(p_limit, 10), 50))
    for update skip locked
  )
  returning e.id, e.payload, e.attempts;
$$;

-- A finished delivery drops its payload: what it said is in a conversation
-- now. One that keeps failing is let go after its last try, payload and all.
create function public.complete_meta_event(p_id text, p_error text default null)
returns void
language sql security definer set search_path = ''
as $$
  update private.meta_events e
  set processed_at = case when p_error is null or e.attempts >= 8 then now() else null end,
      payload = case when p_error is null or e.attempts >= 8 then '{}'::jsonb else e.payload end,
      last_error = left(p_error, 200)
  where e.id = p_id;
$$;

-- ---------------------------------------------------------------------------
-- Filing (service role only, always naming the workspace)
-- ---------------------------------------------------------------------------

-- Files one message from a customer. One conversation per person per channel:
-- it lands on their conversation (reopening it, as an email would) or starts
-- one. Returns {"result": "created" | "threaded" | "duplicate", ...}; a
-- message seen before answers "duplicate" with the message it became.
--   p_kind: reply | story_reply | story_mention | share
create function public.file_social_message(
  p_tenant_id uuid,
  p_channel text,
  p_external_id text,
  p_mid text,
  p_body text,
  p_kind text,
  p_summary text,
  p_subject text,
  p_sent_at timestamptz,
  p_tags text[] default '{}'
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_contact public.contacts;
  v_ticket public.tickets;
  v_message public.messages;
  v_created boolean := false;
  v_sent timestamptz := least(coalesce(p_sent_at, now()), now());
begin
  if p_channel not in ('instagram', 'facebook')
     or p_kind not in ('reply', 'story_reply', 'story_mention', 'share')
     or coalesce(p_external_id, '') = '' or coalesce(p_mid, '') = '' then
    raise exception 'That message can''t be filed' using errcode = '22023';
  end if;
  -- Locking the workspace row keeps ticket numbers gap-free and in order.
  perform 1 from public.tenants t where t.id = p_tenant_id for update;
  if not found then
    raise exception 'Workspace not found' using errcode = 'P0002';
  end if;
  select * into v_message from public.messages m
  where m.tenant_id = p_tenant_id and (m.provider_message_id = p_mid or p_mid = any (m.also_ids));
  if v_message.id is not null then
    return jsonb_build_object('result', 'duplicate', 'tenant_id', p_tenant_id,
                              'ticket_id', v_message.ticket_id, 'message_id', v_message.id);
  end if;

  insert into public.contacts (tenant_id, channel, external_id)
  values (p_tenant_id, p_channel, p_external_id)
  on conflict (tenant_id, channel, external_id) where external_id is not null
    do update set channel = excluded.channel
  returning * into v_contact;

  select * into v_ticket from public.tickets t
  where t.tenant_id = p_tenant_id and t.contact_id = v_contact.id and t.channel = p_channel
  order by t.created_at desc
  limit 1;
  -- Follow a folded conversation to where it went (a few hops at most).
  for i in 1 .. 5 loop
    exit when v_ticket.id is null or v_ticket.merged_into is null;
    select * into v_ticket from public.tickets t
    where t.id = v_ticket.merged_into and t.tenant_id = p_tenant_id;
  end loop;

  if v_ticket.id is null then
    insert into public.tickets (tenant_id, number, contact_id, subject, reply_key, channel)
    values (
      p_tenant_id,
      (select coalesce(max(t.number), 0) + 1 from public.tickets t where t.tenant_id = p_tenant_id),
      v_contact.id,
      left(coalesce(nullif(btrim(p_subject), ''), 'New message'), 200),
      replace(gen_random_uuid()::text, '-', ''),
      p_channel
    )
    returning * into v_ticket;
    v_created := true;
  elsif v_ticket.shelf in ('spam', 'trash') then
    -- Spam and Trash stay put, as with email.
    update public.tickets t set last_message_at = now() where t.id = v_ticket.id;
  else
    update public.tickets t
    set status = 'open', last_message_at = now(), snoozed_until = null, closed_at = null
    where t.id = v_ticket.id;
  end if;

  insert into public.messages
    (tenant_id, ticket_id, direction, body, provider_message_id, kind, summary, sent_at)
  values
    (p_tenant_id, v_ticket.id, 'inbound', left(coalesce(p_body, ''), 8000), p_mid, p_kind,
     nullif(left(btrim(coalesce(p_summary, '')), 120), ''), v_sent)
  returning * into v_message;

  perform private.add_ticket_tags(p_tenant_id, v_ticket.id, p_tags);

  return jsonb_build_object(
    'result', case when v_created then 'created' else 'threaded' end,
    'tenant_id', p_tenant_id,
    'ticket_id', v_ticket.id,
    'message_id', v_message.id,
    'contact_id', v_contact.id,
    'number', v_ticket.number,
    'kept_in', v_ticket.shelf,
    'needs_profile', v_contact.profile_checked_at is null
                     or v_contact.profile_checked_at < now() - interval '30 days'
  );
end;
$$;

-- The person's name and Instagram handle, as Meta gives them. A blank answer
-- still counts as asked, so Meta isn't asked again for a month.
create function public.set_social_profile(
  p_tenant_id uuid, p_contact_id uuid, p_name text, p_handle text
)
returns void
language sql security definer set search_path = ''
as $$
  update public.contacts c
  set name = coalesce(nullif(left(btrim(coalesce(p_name, '')), 120), ''), c.name),
      handle = case when p_handle ~ '^[A-Za-z0-9._]{1,30}$' then p_handle else c.handle end,
      profile_checked_at = now()
  where c.id = p_contact_id and c.tenant_id = p_tenant_id and c.channel <> 'email';
$$;

-- A reply sent from the Instagram or Facebook app itself: filed as the
-- team's, on the person's conversation. Never starts a conversation. While
-- one of the help desk's own sends is still being written down on that
-- conversation it answers "retry", so a message is never filed twice.
create function public.file_social_echo(
  p_tenant_id uuid,
  p_channel text,
  p_external_id text,
  p_mid text,
  p_body text,
  p_summary text,
  p_sent_at timestamptz
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_ticket public.tickets;
  v_id uuid;
begin
  if exists (
    select 1 from public.messages m
    where m.tenant_id = p_tenant_id and (m.provider_message_id = p_mid or p_mid = any (m.also_ids))
  ) then
    return jsonb_build_object('result', 'duplicate');
  end if;
  select t.* into v_ticket
  from public.contacts c
  join public.tickets t on t.contact_id = c.id and t.channel = c.channel
  where c.tenant_id = p_tenant_id and c.channel = p_channel and c.external_id = p_external_id
  order by t.created_at desc
  limit 1;
  for i in 1 .. 5 loop
    exit when v_ticket.id is null or v_ticket.merged_into is null;
    select * into v_ticket from public.tickets t
    where t.id = v_ticket.merged_into and t.tenant_id = p_tenant_id;
  end loop;
  if v_ticket.id is null then
    return jsonb_build_object('result', 'ignored');
  end if;
  perform 1 from public.tickets t where t.id = v_ticket.id for update;
  if exists (
    select 1 from private.outbound_queue q
    where q.ticket_id = v_ticket.id and q.state = 'sending'
  ) then
    return jsonb_build_object('result', 'retry');
  end if;
  if btrim(coalesce(p_body, '')) = '' and btrim(coalesce(p_summary, '')) = '' then
    return jsonb_build_object('result', 'ignored');
  end if;

  insert into public.messages
    (tenant_id, ticket_id, direction, from_name, body, provider_message_id, kind, summary, sent_at)
  values
    (p_tenant_id, v_ticket.id, 'outbound',
     case p_channel when 'instagram' then 'Instagram app' else 'Facebook app' end,
     left(coalesce(p_body, ''), 8000), p_mid, 'reply',
     nullif(left(btrim(coalesce(p_summary, '')), 120), ''),
     least(coalesce(p_sent_at, now()), now()))
  on conflict (tenant_id, provider_message_id) do nothing
  returning id into v_id;
  if v_id is null then
    return jsonb_build_object('result', 'duplicate');
  end if;

  -- Someone answered: it is in progress now, unless it sits in Spam or the Trash.
  update public.tickets t
  set last_message_at = now(),
      status = case when t.status = 'open' and t.shelf is null then 'pending'::public.ticket_status
                    else t.status end,
      first_reply_at = coalesce(t.first_reply_at, now())
  where t.id = v_ticket.id;
  return jsonb_build_object('result', 'threaded', 'ticket_id', v_ticket.id, 'message_id', v_id);
end;
$$;

-- The customer took a message back: its words go, its files go (and are
-- queued for removal from storage), and the conversation says it was removed.
create function public.remove_social_message(p_tenant_id uuid, p_mid text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  update public.messages m
  set body = '', summary = null, format = null, attachments = '[]'::jsonb, removed_at = now()
  where m.tenant_id = p_tenant_id and m.provider_message_id = p_mid
    and m.direction = 'inbound' and m.removed_at is null
    and exists (select 1 from public.tickets t where t.id = m.ticket_id and t.channel <> 'email')
  returning m.id into v_id;
  if v_id is null then
    return false;
  end if;
  delete from public.message_attachments a where a.message_id = v_id;
  return true;
end;
$$;

-- A reaction to a message: kept as a small line in the conversation, one per
-- person per message. It never opens or reopens anything. "unreact" takes it away.
create function public.set_social_reaction(
  p_tenant_id uuid,
  p_reaction_id text,
  p_target_mid text,
  p_emoji text,
  p_sent_at timestamptz
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_ticket uuid;
begin
  delete from public.messages m
  where m.tenant_id = p_tenant_id and m.provider_message_id = p_reaction_id and m.kind = 'reaction';
  if p_emoji is null then
    return true;
  end if;
  select m.ticket_id into v_ticket from public.messages m
  join public.tickets t on t.id = m.ticket_id and t.channel <> 'email'
  where m.tenant_id = p_tenant_id
    and (m.provider_message_id = p_target_mid or p_target_mid = any (m.also_ids));
  if v_ticket is null then
    return false;
  end if;
  insert into public.messages
    (tenant_id, ticket_id, direction, body, provider_message_id, kind, summary, sent_at)
  values
    (p_tenant_id, v_ticket, 'inbound', left(p_emoji, 16), p_reaction_id, 'reaction',
     'Reacted to a message', least(coalesce(p_sent_at, now()), now()))
  on conflict (tenant_id, provider_message_id) do nothing;
  return true;
end;
$$;

-- What the server needs to send a reply: who to, on which channel, and when
-- the customer last did anything (Meta's reply window runs from then).
create function public.social_reply_context(p_tenant_id uuid, p_ticket_id uuid)
returns table (channel text, external_id text, label text, last_inbound_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select t.channel, c.external_id,
         coalesce('@' || c.handle, c.name),
         (select max(coalesce(m.sent_at, m.created_at)) from public.messages m
          where m.ticket_id = t.id and m.direction = 'inbound')
  from public.tickets t
  join public.contacts c on c.id = t.contact_id
  where t.id = p_ticket_id and t.tenant_id = p_tenant_id and t.channel <> 'email';
$$;

-- ---------------------------------------------------------------------------
-- Replies going out
-- ---------------------------------------------------------------------------

-- Records a reply the team sent on Instagram or Facebook: Meta's ids for it
-- (the words, then any pictures), and what happens to the conversation next.
-- The app sends first and passes Meta's ids, so a retry can't store it twice.
-- If Meta's own echo of it was filed first, that row becomes this reply.
create function public.record_social_outbound(
  p_ticket_id uuid,
  p_body text,
  p_mids text[],
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
  v_pictures int := jsonb_array_length(coalesce(p_attachments, '[]'::jsonb));
begin
  if v_ticket.channel = 'email' then
    raise exception 'This conversation is an email' using errcode = '22023';
  end if;
  if coalesce(array_length(p_mids, 1), 0) not between 1 and 4 then
    raise exception 'A sent message needs its id' using errcode = '22023';
  end if;
  if btrim(coalesce(p_body, '')) = '' and v_pictures = 0 then
    raise exception 'A message needs some words or a picture' using errcode = '22023';
  end if;
  if char_length(coalesce(p_body, '')) > 2000 or v_pictures > 3 then
    raise exception 'That message is too big to record' using errcode = '22023';
  end if;
  if p_then not in ('pending', 'open', 'closed', 'snoozed', 'keep') then
    raise exception 'Unknown kind of send' using errcode = '22023';
  end if;
  if p_then = 'snoozed' and (p_snooze_until is null or p_snooze_until <= now()
                             or p_snooze_until > now() + interval '366 days') then
    raise exception 'Pick a time in the coming year' using errcode = '22023';
  end if;

  insert into public.messages
    (tenant_id, ticket_id, direction, body, provider_message_id, also_ids, author_id, kind,
     summary, attachments, sent_at)
  values
    (v_ticket.tenant_id, v_ticket.id, 'outbound', coalesce(p_body, ''), p_mids[1],
     coalesce(p_mids[2:4], '{}'), auth.uid(), 'reply',
     case when v_pictures = 0 then null
          when v_pictures = 1 then 'Sent a photo'
          else 'Sent ' || v_pictures || ' photos' end,
     coalesce(p_attachments, '[]'::jsonb), now())
  on conflict (tenant_id, provider_message_id) do update
    set author_id = excluded.author_id, from_name = null, also_ids = excluded.also_ids,
        attachments = excluded.attachments
    where public.messages.author_id is null and public.messages.direction = 'outbound'
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
      first_reply_at = coalesce(t.first_reply_at, now()),
      assignee_id = coalesce(t.assignee_id, auth.uid())
  where t.id = v_ticket.id;
  return v_id;
end;
$$;

-- Writes down how a queued Instagram or Facebook reply went (the worker).
--   p_mids empty:        nothing went. Failed, with the reason; the words are kept to put back.
--   p_mids, no error:    sent, and filed as its author.
--   p_mids and an error: the words went and the pictures didn't. Filed as what
--                        went, and the notice stays to say so.
create function public.finish_social_outbound(
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
-- The list: a message that is only a picture still says something, and one
-- that was taken back says so.
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
             when m.removed_at is not null then 'Message removed'
             when btrim(m.body) = '' then coalesce(m.summary, '')
             else left(regexp_replace(left(m.body, 600), '\s+', ' ', 'g'), 220)
           end as preview,
           m.direction
    from public.messages m where m.ticket_id = t.id and m.kind <> 'reaction'
    order by m.created_at desc limit 1
  ) l on true
  where t.id = any (p_ticket_ids);
$$;

-- ---------------------------------------------------------------------------
-- What members do
-- ---------------------------------------------------------------------------

-- Writes down an email for someone who messaged, so their orders can be
-- found. It is the team's note about them; nothing is ever sent to it.
create function public.set_contact_known_email(p_contact_id uuid, p_email text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_tenant uuid;
begin
  select c.tenant_id into v_tenant from public.contacts c
  where c.id = p_contact_id and c.channel <> 'email'
    and c.tenant_id in (select private.user_tenant_ids());
  if v_tenant is null then
    raise exception 'Person not found' using errcode = 'P0002';
  end if;
  if v_email is not null and v_email !~ '^[^@\s<>",;]+@[^@\s<>",;]+\.[^@\s<>",;]+$' then
    raise exception 'That isn''t an email address' using errcode = '22023';
  end if;
  update public.contacts c set known_email = v_email where c.id = p_contact_id;
end;
$$;

-- Forgets someone who messaged on Instagram or Facebook: the person, their
-- conversations, what was said and every file (queued for removal from
-- storage by the attachments trigger). Owners and admins only.
create function public.forget_social_person(p_contact_id uuid)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_contact public.contacts;
  v_tickets int;
begin
  select * into v_contact from public.contacts c
  where c.id = p_contact_id and c.channel <> 'email'
    and c.tenant_id in (select private.user_tenant_ids());
  if not found then
    raise exception 'Person not found' using errcode = 'P0002';
  end if;
  if not private.has_tenant_role(v_contact.tenant_id, array['owner', 'admin']::public.membership_role[]) then
    raise exception 'Only owners and admins can forget a customer' using errcode = '42501';
  end if;
  select count(*)::int into v_tickets from public.tickets t where t.contact_id = v_contact.id;
  delete from public.contacts c where c.id = v_contact.id;
  -- The log says it happened and on which channel; never who it was.
  perform private.log_audit(v_contact.tenant_id, 'privacy.social_person_forgotten', 'contact', null,
    jsonb_build_object('channel', v_contact.channel, 'conversations', v_tickets));
  return v_tickets;
end;
$$;

-- ---------------------------------------------------------------------------
-- Meta's data deletion callback. Meta names a person by an id; whatever we
-- hold under that id, in any workspace, is deleted by the worker. The id is
-- cleared once that is done; the code is what the person checks back with.
-- ---------------------------------------------------------------------------

create table private.meta_deletions (
  code text primary key check (code ~ '^[a-z0-9]{16,40}$'),
  external_id text,
  requested_at timestamptz not null default now(),
  done_at timestamptz,
  removed int
);
alter table private.meta_deletions enable row level security;
revoke all on private.meta_deletions from public, anon, authenticated, service_role;

create function public.request_meta_deletion(p_code text, p_external_id text)
returns void
language sql security definer set search_path = ''
as $$
  insert into private.meta_deletions (code, external_id) values (p_code, p_external_id);
$$;

-- Does the waiting deletions. Returns how many requests were handled.
create function public.run_meta_deletions(p_limit int default 20)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_row private.meta_deletions;
  v_removed int;
  v_done int := 0;
begin
  for v_row in
    select * from private.meta_deletions d
    where d.done_at is null
    order by d.requested_at
    limit greatest(1, least(coalesce(p_limit, 20), 100))
    for update skip locked
  loop
    with gone as (
      delete from public.contacts c
      where c.channel <> 'email' and c.external_id = v_row.external_id
      returning c.tenant_id, c.channel
    ), logged as (
      insert into public.audit_log (tenant_id, action, target_type, metadata)
      select g.tenant_id, 'privacy.social_person_forgotten', 'contact',
             jsonb_build_object('channel', g.channel, 'asked_by', 'meta')
      from gone g
      returning 1
    )
    select count(*)::int into v_removed from logged;
    update private.meta_deletions d
    set done_at = now(), removed = v_removed, external_id = null
    where d.code = v_row.code;
    v_done := v_done + 1;
  end loop;
  return v_done;
end;
$$;

-- For the page Meta sends the person to: 'received', 'done' or null (no such code).
create function public.meta_deletion_status(p_code text)
returns text
language sql stable security definer set search_path = ''
as $$
  select case when d.done_at is null then 'received' else 'done' end
  from private.meta_deletions d where d.code = p_code;
$$;

-- A shop's privacy request for an email now also forgets anyone on Instagram
-- or Facebook the team had written that email down for.
create or replace function public.redact_customer(
  p_tenant_id uuid,
  p_provider text,
  p_customer_external_id text,
  p_email text default null
)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_orders int;
  v_email text;
begin
  select coalesce(lower(p_email), c.email) into v_email from public.customers c
  where c.tenant_id = p_tenant_id and c.provider = p_provider and c.external_id = p_customer_external_id;
  v_email := coalesce(v_email, lower(p_email));

  delete from public.customers c
  where c.tenant_id = p_tenant_id and c.provider = p_provider
    and (c.external_id = p_customer_external_id or (v_email is not null and c.email = v_email));

  update public.orders o
  set customer_external_id = null, email = null
  where o.tenant_id = p_tenant_id and o.provider = p_provider
    and (o.customer_external_id = p_customer_external_id or (v_email is not null and o.email = v_email));
  get diagnostics v_orders = row_count;

  if v_email is not null then
    delete from public.contacts c
    where c.tenant_id = p_tenant_id and (c.email = v_email or c.known_email = v_email);
  end if;

  insert into public.audit_log (tenant_id, action, target_type, target_id, metadata)
  values (p_tenant_id, 'privacy.customer_redacted', 'customer', p_customer_external_id,
          jsonb_build_object('provider', p_provider, 'orders_anonymised', v_orders));
  return v_orders;
end;
$$;

-- ---------------------------------------------------------------------------
-- Who may call what
-- ---------------------------------------------------------------------------

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.record_social_outbound(uuid, text, text[], jsonb, text, timestamptz)',
    'public.set_contact_known_email(uuid, text)',
    'public.forget_social_person(uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
  foreach fn in array array[
    'public.resolve_meta_channel(text, text)',
    'public.enqueue_meta_event(text, jsonb)',
    'public.claim_meta_events(int)',
    'public.complete_meta_event(text, text)',
    'public.file_social_message(uuid, text, text, text, text, text, text, text, timestamptz, text[])',
    'public.set_social_profile(uuid, uuid, text, text)',
    'public.file_social_echo(uuid, text, text, text, text, text, timestamptz)',
    'public.remove_social_message(uuid, text)',
    'public.set_social_reaction(uuid, text, text, text, timestamptz)',
    'public.social_reply_context(uuid, uuid)',
    'public.finish_social_outbound(uuid, text[], text, jsonb, text)',
    'public.request_meta_deletion(text, text)',
    'public.run_meta_deletions(int)',
    'public.meta_deletion_status(text)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
