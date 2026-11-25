-- Help desk, eighth pass: comments on Instagram and Facebook posts.
-- A comment on one of the business's own posts can become a conversation,
-- beside the messages the seventh pass brought in and on the same connection.
-- One conversation per person per post: their comment, their later comments
-- and replies under it, and what the team answered. The team answers in
-- public (a reply under the comment) or, once per comment, with a private
-- message; if the person answers that, it carries on as their ordinary
-- message conversation. Meta's webhook is still only verified and queued by
-- the web service; the worker files. Comments are only taken where a manager
-- switched them on and Facebook granted the permissions for them.
--
-- Who may do what:
--   members          read; record a public or private reply they sent; note a
--                    comment as hidden or shown again
--   owners, admins   note a comment as deleted
--   the worker       everything Meta delivers, and replies that waited in the outbox

-- ---------------------------------------------------------------------------
-- The post a comment is on: its address and a few of its words, read from
-- Meta once so the team can see what the comment is about. Never its
-- pictures or video.
-- ---------------------------------------------------------------------------

create table public.comment_posts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  channel text not null check (channel in ('instagram', 'facebook')),
  -- Meta's id for the post (Facebook) or the media (Instagram).
  external_id text not null check (char_length(external_id) between 1 and 200),
  -- Only ever an address on the platform itself.
  permalink text check (permalink is null or (char_length(permalink) <= 500
    and permalink ~ '^https://(www\.)?(facebook|instagram)\.com/')),
  -- The start of the post's caption, as plain text.
  excerpt text not null default '' check (char_length(excerpt) <= 300),
  -- When Meta was asked about it. Asked once.
  checked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, channel, external_id)
);
alter table public.comment_posts enable row level security;
create policy "members read their comment posts" on public.comment_posts for select to authenticated
  using (tenant_id in (select private.user_tenant_ids()));
revoke all on public.comment_posts from public, anon, authenticated, service_role;
grant select on public.comment_posts to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- A conversation says whether it is messages or comments on a post
-- ---------------------------------------------------------------------------

alter table public.tickets
  add column kind text not null default 'message' check (kind in ('message', 'comment')),
  add column comment_post_id uuid references public.comment_posts (id) on delete set null,
  add constraint tickets_comment_shape check (kind = 'message' or channel <> 'email');
create index tickets_comment_thread_idx
  on public.tickets (tenant_id, contact_id, comment_post_id, created_at desc) where kind = 'comment';
grant select (kind, comment_post_id) on public.tickets to authenticated;

alter table public.messages
  -- A comment the person changed afterwards: the words are the new ones.
  add column edited_at timestamptz,
  -- Hidden from everyone else on the platform (by the team, here or there).
  add column hidden boolean not null default false,
  -- The comment this one was written under (Meta's id), for replies.
  add column parent_external_id text check (parent_external_id is null
    or char_length(parent_external_id) between 1 and 200),
  -- On a customer's comment: Meta allows one private message about it.
  -- 'claimed' while that message is being sent, 'sent' once it has gone.
  add column private_reply text check (private_reply in ('claimed', 'sent')),
  add column private_reply_at timestamptz;
alter table public.messages drop constraint messages_kind_check;
alter table public.messages add constraint messages_kind_check check (kind in
  ('reply', 'forward', 'story_reply', 'story_mention', 'share', 'reaction',
   -- A public comment (theirs, or the team's reply under it), and the one
   -- private message the team may send about a comment.
   'comment', 'private_reply'));

-- A conversation keeps its kind, and comments are never joined with messages:
-- a reply could only go one way.
create function private.keep_kinds_apart()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.kind is distinct from old.kind then
    raise exception 'A conversation keeps the kind it started as' using errcode = '22023';
  end if;
  if new.merged_into is not null and new.merged_into is distinct from old.merged_into
     and (new.kind = 'comment'
          or (select t.kind from public.tickets t where t.id = new.merged_into) = 'comment') then
    raise exception 'Conversations about comments can''t be joined' using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke all on function private.keep_kinds_apart() from public;
create trigger tickets_keep_kinds_apart
  before update on public.tickets
  for each row execute function private.keep_kinds_apart();

-- ---------------------------------------------------------------------------
-- Which workspace a comment belongs to. Only a live Meta connection that was
-- granted the permissions for comments, in a workspace that has switched
-- comments on for that platform, counts.
-- ---------------------------------------------------------------------------

create function private.meta_comment_channel(p_object text, p_account_id text)
returns table (tenant_id uuid, connection_id uuid, channel text, page_id text, own_handle text)
language sql stable security definer set search_path = ''
as $$
  select c.tenant_id, c.id, w.channel, c.external_account_id, c.metadata ->> 'instagram_username'
  from (select case p_object when 'instagram' then 'instagram' when 'page' then 'facebook' end as channel) w
  join public.connections c
    on c.provider = 'meta' and c.status = 'active'
   and c.scopes @> array['pages_manage_metadata', 'pages_read_engagement']
   and case w.channel
         when 'facebook' then c.external_account_id = p_account_id
                              and c.scopes @> array['pages_read_user_content']
         when 'instagram' then c.metadata ->> 'instagram_id' = p_account_id
                               and c.scopes @> array['instagram_manage_comments', 'instagram_basic']
         else false
       end
  where p_account_id is not null and p_account_id <> ''
    and exists (
      select 1 from public.configs g
      where g.tenant_id = c.tenant_id and g.module = 'helpdesk' and g.key = 'channels'
        and jsonb_typeof(g.body -> (w.channel || '_comments')) = 'boolean'
        and (g.body ->> (w.channel || '_comments'))::boolean
    )
  limit 1;
$$;
revoke all on function private.meta_comment_channel(text, text) from public;

-- For the worker: whose a comment is. Service role only.
create function public.resolve_meta_comments(p_object text, p_account_id text)
returns table (tenant_id uuid, connection_id uuid, channel text, page_id text, own_handle text)
language sql stable security definer set search_path = ''
as $$
  select * from private.meta_comment_channel(p_object, p_account_id);
$$;

-- A delivery is kept when its account is connected for messages or for comments.
create or replace function public.enqueue_meta_event(p_id text, p_payload jsonb)
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
       or exists (select 1 from private.meta_comment_channel(p_payload ->> 'object', e ->> 'id'))
  ) then
    return 'dropped';
  end if;
  insert into private.meta_events (id, payload) values (p_id, p_payload)
  on conflict (id) do nothing;
  get diagnostics v_inserted = row_count;
  return case when v_inserted = 1 then 'queued' else 'duplicate' end;
end;
$$;

-- ---------------------------------------------------------------------------
-- Messages and comments stay apart: a message lands on the person's message
-- conversation, never on one about a comment. (The four functions below are
-- the seventh pass's, with that one condition added.)
-- ---------------------------------------------------------------------------

create or replace function public.file_social_message(
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
    and t.kind = 'message'
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

create or replace function public.file_social_echo(
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
  join public.tickets t on t.contact_id = c.id and t.channel = c.channel and t.kind = 'message'
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

create or replace function public.social_reply_context(p_tenant_id uuid, p_ticket_id uuid)
returns table (channel text, external_id text, label text, last_inbound_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select t.channel, c.external_id,
         coalesce('@' || c.handle, c.name),
         (select max(coalesce(m.sent_at, m.created_at)) from public.messages m
          where m.ticket_id = t.id and m.direction = 'inbound')
  from public.tickets t
  join public.contacts c on c.id = t.contact_id
  where t.id = p_ticket_id and t.tenant_id = p_tenant_id and t.channel <> 'email'
    and t.kind = 'message';
$$;

create or replace function public.record_social_outbound(
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
  if v_ticket.kind <> 'message' then
    raise exception 'This conversation is about a comment' using errcode = '22023';
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

-- ---------------------------------------------------------------------------
-- Filing comments (service role only, always naming the workspace)
-- ---------------------------------------------------------------------------

-- Files one comment from a customer. One conversation per person per post:
-- it lands on that conversation (reopening it) or, when p_start says the
-- comment is worth one, starts it. A comment that isn't worth a conversation
-- by itself is still kept on one that is already going. Returns
-- {"result": "created" | "threaded" | "duplicate" | "filtered", ...}.
create function public.file_social_comment(
  p_tenant_id uuid,
  p_channel text,
  p_external_id text,
  p_name text,
  p_handle text,
  p_comment_id text,
  p_parent_id text,
  p_post_external_id text,
  p_body text,
  p_summary text,
  p_subject text,
  p_sent_at timestamptz,
  p_start boolean default true,
  p_tags text[] default '{}'
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_contact public.contacts;
  v_post public.comment_posts;
  v_ticket public.tickets;
  v_message public.messages;
  v_created boolean := false;
  v_sent timestamptz := least(coalesce(p_sent_at, now()), now());
  v_handle text := case when p_handle ~ '^[A-Za-z0-9._]{1,30}$' then p_handle end;
  v_name text := nullif(left(btrim(coalesce(p_name, '')), 120), '');
begin
  if p_channel not in ('instagram', 'facebook')
     or coalesce(p_external_id, '') = '' or coalesce(p_comment_id, '') = ''
     or coalesce(p_post_external_id, '') = '' then
    raise exception 'That comment can''t be filed' using errcode = '22023';
  end if;
  -- Locking the workspace row keeps ticket numbers gap-free and in order.
  perform 1 from public.tenants t where t.id = p_tenant_id for update;
  if not found then
    raise exception 'Workspace not found' using errcode = 'P0002';
  end if;
  select * into v_message from public.messages m
  where m.tenant_id = p_tenant_id and m.provider_message_id = p_comment_id;
  if v_message.id is not null then
    return jsonb_build_object('result', 'duplicate', 'tenant_id', p_tenant_id,
                              'ticket_id', v_message.ticket_id, 'message_id', v_message.id);
  end if;

  select * into v_contact from public.contacts c
  where c.tenant_id = p_tenant_id and c.channel = p_channel and c.external_id = p_external_id;
  select * into v_post from public.comment_posts p
  where p.tenant_id = p_tenant_id and p.channel = p_channel and p.external_id = p_post_external_id;
  if v_contact.id is not null and v_post.id is not null then
    select * into v_ticket from public.tickets t
    where t.tenant_id = p_tenant_id and t.contact_id = v_contact.id and t.kind = 'comment'
      and t.comment_post_id = v_post.id
    order by t.created_at desc
    limit 1;
  end if;
  if v_ticket.id is null and not coalesce(p_start, true) then
    -- Nothing going with this person on this post, and nothing here to start on.
    return jsonb_build_object('result', 'filtered');
  end if;

  -- A comment arrives with its author's name (Facebook) or username
  -- (Instagram), so there is nothing more to ask Meta about them.
  insert into public.contacts (tenant_id, channel, external_id, name, handle, profile_checked_at)
  values (p_tenant_id, p_channel, p_external_id, v_name, v_handle,
          case when v_name is not null or v_handle is not null then now() end)
  on conflict (tenant_id, channel, external_id) where external_id is not null
    do update set name = coalesce(excluded.name, public.contacts.name),
                  handle = coalesce(excluded.handle, public.contacts.handle),
                  profile_checked_at = coalesce(excluded.profile_checked_at,
                                                public.contacts.profile_checked_at)
  returning * into v_contact;

  if v_post.id is null then
    insert into public.comment_posts (tenant_id, channel, external_id)
    values (p_tenant_id, p_channel, p_post_external_id)
    on conflict (tenant_id, channel, external_id) do update set channel = excluded.channel
    returning * into v_post;
  end if;

  if v_ticket.id is null then
    insert into public.tickets
      (tenant_id, number, contact_id, subject, reply_key, channel, kind, comment_post_id)
    values (
      p_tenant_id,
      (select coalesce(max(t.number), 0) + 1 from public.tickets t where t.tenant_id = p_tenant_id),
      v_contact.id,
      left(coalesce(nullif(btrim(p_subject), ''), 'New comment'), 200),
      replace(gen_random_uuid()::text, '-', ''),
      p_channel, 'comment', v_post.id
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
    (tenant_id, ticket_id, direction, from_name, body, provider_message_id, kind, summary,
     sent_at, parent_external_id)
  values
    (p_tenant_id, v_ticket.id, 'inbound', coalesce('@' || v_handle, v_name),
     left(coalesce(p_body, ''), 8000), p_comment_id, 'comment',
     nullif(left(btrim(coalesce(p_summary, '')), 120), ''), v_sent,
     nullif(left(coalesce(p_parent_id, ''), 200), ''))
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
    'post_id', v_post.id,
    'needs_post', v_post.checked_at is null
  );
end;
$$;

-- What Meta said about a post, kept the first time only: its address (only
-- ever on the platform itself) and the start of its caption as plain text.
create function public.set_comment_post(
  p_tenant_id uuid, p_post_id uuid, p_permalink text, p_excerpt text
)
returns void
language sql security definer set search_path = ''
as $$
  update public.comment_posts p
  set permalink = case when char_length(p_permalink) <= 500
                        and p_permalink ~ '^https://(www\.)?(facebook|instagram)\.com/'
                       then p_permalink end,
      excerpt = left(btrim(regexp_replace(coalesce(p_excerpt, ''), '\s+', ' ', 'g')), 280),
      checked_at = now()
  where p.id = p_post_id and p.tenant_id = p_tenant_id and p.checked_at is null;
$$;

-- A comment by the Page or the Instagram account itself, written in the
-- Facebook or Instagram app (or by the help desk, heard back from Meta):
-- filed as the team's, under the customer's comment it answers. Never starts
-- a conversation. While one of the help desk's own sends is still being
-- written down on that conversation it answers "retry", so a reply is never
-- filed twice.
create function public.file_own_comment(
  p_tenant_id uuid,
  p_channel text,
  p_comment_id text,
  p_parent_id text,
  p_body text,
  p_sent_at timestamptz
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_ticket uuid;
  v_id uuid;
begin
  if exists (
    select 1 from public.messages m
    where m.tenant_id = p_tenant_id and m.provider_message_id = p_comment_id
  ) then
    return jsonb_build_object('result', 'duplicate');
  end if;
  select m.ticket_id into v_ticket
  from public.messages m
  join public.tickets t on t.id = m.ticket_id and t.kind = 'comment' and t.channel = p_channel
  where m.tenant_id = p_tenant_id and m.provider_message_id = p_parent_id;
  if v_ticket is null or btrim(coalesce(p_body, '')) = '' then
    return jsonb_build_object('result', 'ignored');
  end if;
  perform 1 from public.tickets t where t.id = v_ticket for update;
  if exists (
    select 1 from private.outbound_queue q where q.ticket_id = v_ticket and q.state = 'sending'
  ) then
    return jsonb_build_object('result', 'retry');
  end if;

  insert into public.messages
    (tenant_id, ticket_id, direction, from_name, body, provider_message_id, kind, sent_at,
     parent_external_id)
  values
    (p_tenant_id, v_ticket, 'outbound',
     case p_channel when 'instagram' then 'Instagram app' else 'Facebook app' end,
     left(p_body, 8000), p_comment_id, 'comment', least(coalesce(p_sent_at, now()), now()),
     left(p_parent_id, 200))
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
  where t.id = v_ticket;
  return jsonb_build_object('result', 'threaded', 'ticket_id', v_ticket, 'message_id', v_id);
end;
$$;

-- The person changed their comment: the words become the new ones, marked as edited.
create function public.edit_social_comment(
  p_tenant_id uuid, p_comment_id text, p_body text, p_edited_at timestamptz
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  update public.messages m
  set body = left(coalesce(p_body, ''), 8000),
      edited_at = least(coalesce(p_edited_at, now()), now())
  where m.tenant_id = p_tenant_id and m.provider_message_id = p_comment_id
    and m.kind = 'comment' and m.removed_at is null
    and m.body is distinct from left(coalesce(p_body, ''), 8000)
  returning m.id into v_id;
  return v_id is not null;
end;
$$;

-- A comment was taken down on the platform (by its author, or by the team in
-- the app): its words go, its files go, and the conversation says so.
create function public.remove_social_comment(p_tenant_id uuid, p_comment_id text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  update public.messages m
  set body = '', summary = null, format = null, attachments = '[]'::jsonb, removed_at = now()
  where m.tenant_id = p_tenant_id and m.provider_message_id = p_comment_id
    and m.kind = 'comment' and m.removed_at is null
  returning m.id into v_id;
  if v_id is null then
    return false;
  end if;
  delete from public.message_attachments a where a.message_id = v_id;
  return true;
end;
$$;

-- A comment was hidden or shown again on the platform.
create function public.set_comment_hidden(p_tenant_id uuid, p_comment_id text, p_hidden boolean)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  update public.messages m
  set hidden = coalesce(p_hidden, false)
  where m.tenant_id = p_tenant_id and m.provider_message_id = p_comment_id and m.kind = 'comment'
  returning m.id into v_id;
  return v_id is not null;
end;
$$;

-- What the server needs to answer a comment: who wrote it, on which
-- platform, and the customer's latest comment that still stands (replies go
-- under it, and the one private message is about it).
create function public.comment_reply_context(p_tenant_id uuid, p_ticket_id uuid)
returns table (
  channel text, external_id text, label text, comment_id text, comment_message_id uuid,
  comment_at timestamptz, comment_hidden boolean, private_reply text
)
language sql stable security definer set search_path = ''
as $$
  select t.channel, c.external_id, coalesce('@' || c.handle, c.name),
         m.provider_message_id, m.id, coalesce(m.sent_at, m.created_at), m.hidden, m.private_reply
  from public.tickets t
  join public.contacts c on c.id = t.contact_id
  left join lateral (
    select * from public.messages x
    where x.ticket_id = t.id and x.direction = 'inbound' and x.kind = 'comment'
      and x.removed_at is null
    order by coalesce(x.sent_at, x.created_at) desc
    limit 1
  ) m on true
  where t.id = p_ticket_id and t.tenant_id = p_tenant_id and t.kind = 'comment';
$$;

-- Meta allows one private message about a comment, within seven days of it.
-- Taking the claim is what makes that rule hold here: whoever gets "true"
-- may send; everyone after gets "false".
create function public.claim_private_reply(p_tenant_id uuid, p_ticket_id uuid, p_comment_id text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  update public.messages m
  set private_reply = 'claimed', private_reply_at = now()
  where m.tenant_id = p_tenant_id and m.ticket_id = p_ticket_id
    and m.provider_message_id = p_comment_id
    and m.direction = 'inbound' and m.kind = 'comment' and m.removed_at is null
    and m.private_reply is null
    and coalesce(m.sent_at, m.created_at) > now() - interval '7 days'
  returning m.id into v_id;
  return v_id is not null;
end;
$$;

-- Meta said no and nothing went: the comment can have its private message after all.
create function public.release_private_reply(p_tenant_id uuid, p_comment_id text)
returns void
language sql security definer set search_path = ''
as $$
  update public.messages m
  set private_reply = null, private_reply_at = null
  where m.tenant_id = p_tenant_id and m.provider_message_id = p_comment_id
    and m.private_reply = 'claimed';
$$;

-- ---------------------------------------------------------------------------
-- Replies going out
-- ---------------------------------------------------------------------------

-- Records an answer to a comment that the team sent: a public reply under it
-- (p_via 'public', p_external_id is Meta's id for the new comment) or the one
-- private message about it (p_via 'private', Meta's id for that message).
-- The app sends first and passes Meta's id, so a retry can't store it twice.
-- If Meta's own word of it was filed first, that row becomes this reply.
create function public.record_comment_outbound(
  p_ticket_id uuid,
  p_body text,
  p_external_id text,
  p_via text,
  p_comment_id text,
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
  if v_ticket.kind <> 'comment' then
    raise exception 'This conversation isn''t about a comment' using errcode = '22023';
  end if;
  if p_via is null or p_via not in ('public', 'private') then
    raise exception 'Say how it was sent' using errcode = '22023';
  end if;
  if coalesce(p_external_id, '') = '' or char_length(p_external_id) > 200 then
    raise exception 'A sent reply needs its id' using errcode = '22023';
  end if;
  if btrim(coalesce(p_body, '')) = '' or char_length(p_body) > 8000 then
    raise exception 'A reply needs some words' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.messages m
    where m.ticket_id = v_ticket.id and m.provider_message_id = p_comment_id
      and m.direction = 'inbound' and m.kind = 'comment'
  ) then
    raise exception 'That comment isn''t on this conversation' using errcode = '22023';
  end if;
  if p_then not in ('pending', 'open', 'closed', 'snoozed', 'keep') then
    raise exception 'Unknown kind of send' using errcode = '22023';
  end if;
  if p_then = 'snoozed' and (p_snooze_until is null or p_snooze_until <= now()
                             or p_snooze_until > now() + interval '366 days') then
    raise exception 'Pick a time in the coming year' using errcode = '22023';
  end if;

  insert into public.messages
    (tenant_id, ticket_id, direction, body, provider_message_id, author_id, kind, sent_at,
     parent_external_id)
  values
    (v_ticket.tenant_id, v_ticket.id, 'outbound', p_body, p_external_id, auth.uid(),
     case p_via when 'public' then 'comment' else 'private_reply' end, now(), p_comment_id)
  on conflict (tenant_id, provider_message_id) do update
    set author_id = excluded.author_id, from_name = null
    where public.messages.author_id is null and public.messages.direction = 'outbound'
  returning id into v_id;
  if v_id is null then
    return null;
  end if;
  if p_via = 'private' then
    update public.messages m
    set private_reply = 'sent', private_reply_at = now()
    where m.ticket_id = v_ticket.id and m.provider_message_id = p_comment_id;
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

-- Writes down how a queued answer to a comment went (the worker).
--   p_external_id null:  nothing went. Failed, with the reason; the words are
--                        kept to put back. (A private message's claim on its
--                        comment is given back by the sender itself, and only
--                        when Meta refused: this function never touches it,
--                        so one send can't free a claim another one holds.)
--   otherwise:           sent, and filed as its author.
create function public.finish_comment_outbound(
  p_id uuid,
  p_external_id text default null,
  p_body text default null,
  p_error text default null
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_row private.outbound_queue;
  v_then text;
  v_until timestamptz;
  v_via text;
  v_comment text;
  v_message uuid;
begin
  select * into v_row from private.outbound_queue q where q.id = p_id and q.state = 'sending' for update;
  if not found then
    return null;
  end if;
  v_via := v_row.payload ->> 'via';
  v_comment := v_row.payload ->> 'comment_id';
  if coalesce(p_external_id, '') = '' then
    update private.outbound_queue q
    set state = 'failed', error = left(coalesce(p_error, 'unknown'), 200), finished_at = now()
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
    v_message := public.record_comment_outbound(
      v_row.ticket_id, p_body, p_external_id, v_via, v_comment, v_then, v_until);
    perform public.apply_send_actions(
      v_row.ticket_id,
      array(select jsonb_array_elements_text(coalesce(v_row.payload -> 'add_tags', '[]'::jsonb))),
      (v_row.payload ->> 'assign_to')::uuid);
    insert into public.ticket_reads (tenant_id, ticket_id, user_id)
    values (v_row.tenant_id, v_row.ticket_id, v_row.author_id)
    on conflict (ticket_id, user_id) do update set read_at = now();
  exception when others then
    -- The reply has gone; only the filing failed. Say so rather than lose it.
    update private.outbound_queue q
    set state = 'unsure', error = 'sent_not_filed', payload = '{}'::jsonb, finished_at = now()
    where q.id = p_id;
    return null;
  end;
  update private.outbound_queue q
  set state = 'sent', error = null, payload = '{}'::jsonb, finished_at = now()
  where q.id = p_id;
  return v_message;
end;
$$;

-- ---------------------------------------------------------------------------
-- What members do, once Meta has done it
-- ---------------------------------------------------------------------------

-- Notes a customer's comment as hidden (or shown again) after Meta took the
-- change. The whole team may hide.
create function public.mark_comment_hidden(p_message_id uuid, p_hidden boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.messages m
  set hidden = coalesce(p_hidden, false)
  where m.id = p_message_id and m.kind = 'comment' and m.direction = 'inbound'
    and m.removed_at is null
    and m.tenant_id in (select private.user_tenant_ids());
  if not found then
    raise exception 'Comment not found' using errcode = 'P0002';
  end if;
end;
$$;

-- Notes a comment as deleted after Meta deleted it: its words and files go
-- here too. Owners and admins only.
create function public.mark_comment_deleted(p_message_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  select m.tenant_id into v_tenant from public.messages m
  where m.id = p_message_id and m.kind = 'comment'
    and m.tenant_id in (select private.user_tenant_ids());
  if v_tenant is null then
    raise exception 'Comment not found' using errcode = 'P0002';
  end if;
  if not private.has_tenant_role(v_tenant, array['owner', 'admin']::public.membership_role[]) then
    raise exception 'Only owners and admins can delete a comment' using errcode = '42501';
  end if;
  update public.messages m
  set body = '', summary = null, format = null, attachments = '[]'::jsonb, removed_at = now()
  where m.id = p_message_id and m.removed_at is null;
  delete from public.message_attachments a where a.message_id = p_message_id;
  -- The log says it happened; never whose comment or what it said.
  perform private.log_audit(v_tenant, 'helpdesk.comment_deleted', 'message', null, '{}'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- The list: a comment that was taken down says so.
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
    from public.messages m where m.ticket_id = t.id and m.kind <> 'reaction'
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
    'public.record_comment_outbound(uuid, text, text, text, text, text, timestamptz)',
    'public.mark_comment_hidden(uuid, boolean)',
    'public.mark_comment_deleted(uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
  foreach fn in array array[
    'public.resolve_meta_comments(text, text)',
    'public.file_social_comment(uuid, text, text, text, text, text, text, text, text, text, text, timestamptz, boolean, text[])',
    'public.set_comment_post(uuid, uuid, text, text)',
    'public.file_own_comment(uuid, text, text, text, text, timestamptz)',
    'public.edit_social_comment(uuid, text, text, timestamptz)',
    'public.remove_social_comment(uuid, text)',
    'public.set_comment_hidden(uuid, text, boolean)',
    'public.comment_reply_context(uuid, uuid)',
    'public.claim_private_reply(uuid, uuid, text)',
    'public.release_private_reply(uuid, text)',
    'public.finish_comment_outbound(uuid, text, text, text)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
