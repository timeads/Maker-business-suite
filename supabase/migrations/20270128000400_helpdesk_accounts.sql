-- Help desk: every Instagram and Facebook conversation carries the ACCOUNT
-- the customer wrote to, and is answered as that account.
--
-- A delivery is routed by the platform id on its webhook entry to a
-- workspace AND one of its accounts (`resolve_meta_account`, from the
-- previous migration). The worker files through `file_account_message` and
-- `file_account_comment`, which name the account and hand over to the
-- filing functions that were already there, so their rules (once per Meta
-- id, threading, Spam and Trash, messages and comments kept apart) are
-- unchanged. The account is written on the person, the conversation and the
-- post by a trigger while the filing runs.
--
-- "One conversation per person per channel" is now per person per ACCOUNT:
-- Meta gives a person a different id on each Page and each Instagram
-- account (a Page-scoped or Instagram-scoped id), so the same human writing
-- to two accounts is two people here, with a conversation each.
--
-- Existing conversations, people and posts are moved across in place at the
-- end: each is given its channel's account on the workspace's connection.

alter table public.contacts
  add column social_account_id uuid references public.social_accounts (id) on delete set null;
alter table public.tickets
  add column social_account_id uuid references public.social_accounts (id) on delete set null;
alter table public.comment_posts
  add column social_account_id uuid references public.social_accounts (id) on delete set null;
create index tickets_account_idx on public.tickets (tenant_id, social_account_id, last_message_at desc)
  where social_account_id is not null;
grant select (social_account_id) on public.tickets to authenticated;

-- A conversation keeps the account it came to.
create function private.keep_ticket_account()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if old.social_account_id is not null and new.social_account_id is distinct from old.social_account_id then
    raise exception 'A conversation keeps the account it came to' using errcode = '22023';
  end if;
  -- Joined conversations were answered as one account: keep them on one.
  if new.merged_into is not null and new.merged_into is distinct from old.merged_into
     and new.social_account_id is not null
     and new.social_account_id is distinct from
         (select t.social_account_id from public.tickets t where t.id = new.merged_into) then
    raise exception 'Conversations with different accounts can''t be joined' using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke all on function private.keep_ticket_account() from public;
create trigger tickets_keep_account
  before update on public.tickets
  for each row execute function private.keep_ticket_account();

-- While a filing names its account, what it creates carries it.
create function private.stamp_social_account()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_account uuid := nullif(current_setting('mbs.social_account', true), '')::uuid;
begin
  if new.social_account_id is not null or new.channel = 'email' then
    return new;
  end if;
  if v_account is not null then
    new.social_account_id := v_account;
  elsif tg_table_name = 'tickets' then
    -- Started some other way: the person's account, when they have one.
    select c.social_account_id into new.social_account_id
    from public.contacts c where c.id = new.contact_id;
  end if;
  return new;
end;
$$;
revoke all on function private.stamp_social_account() from public;
create trigger contacts_stamp_account before insert on public.contacts
  for each row execute function private.stamp_social_account();
create trigger tickets_stamp_account before insert on public.tickets
  for each row execute function private.stamp_social_account();
create trigger comment_posts_stamp_account before insert on public.comment_posts
  for each row execute function private.stamp_social_account();

-- The account a filing is for must be the workspace's, on that channel.
create function private.check_filing_account(p_tenant_id uuid, p_account uuid, p_channel text)
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.social_accounts a
    where a.id = p_account and a.tenant_id = p_tenant_id and a.network = p_channel
  ) then
    raise exception 'That account isn''t this workspace''s' using errcode = '22023';
  end if;
end;
$$;
revoke all on function private.check_filing_account(uuid, uuid, text) from public;

-- After a filing: a person or conversation from before accounts is this account's.
create function private.claim_filed_for_account(p_tenant_id uuid, p_account uuid, p_filed jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform set_config('mbs.social_account', '', true);
  update public.tickets t set social_account_id = p_account
  where t.id = (p_filed ->> 'ticket_id')::uuid and t.tenant_id = p_tenant_id
    and t.social_account_id is null;
  update public.contacts c set social_account_id = p_account
  where c.id = (p_filed ->> 'contact_id')::uuid and c.tenant_id = p_tenant_id
    and c.social_account_id is null;
  update public.comment_posts p set social_account_id = p_account
  where p.id = (p_filed ->> 'post_id')::uuid and p.tenant_id = p_tenant_id
    and p.social_account_id is null;
end;
$$;
revoke all on function private.claim_filed_for_account(uuid, uuid, jsonb) from public;

-- Files one message for an account (service role). The same as
-- file_social_message, which does the filing, plus the account.
create function public.file_account_message(
  p_social_account_id uuid,
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
  v_filed jsonb;
begin
  perform private.check_filing_account(p_tenant_id, p_social_account_id, p_channel);
  perform set_config('mbs.social_account', p_social_account_id::text, true);
  v_filed := public.file_social_message(p_tenant_id, p_channel, p_external_id, p_mid, p_body,
    p_kind, p_summary, p_subject, p_sent_at, p_tags);
  perform private.claim_filed_for_account(p_tenant_id, p_social_account_id, v_filed);
  return v_filed;
end;
$$;

-- Files one comment for an account (service role), through file_social_comment.
create function public.file_account_comment(
  p_social_account_id uuid,
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
  v_filed jsonb;
begin
  perform private.check_filing_account(p_tenant_id, p_social_account_id, p_channel);
  perform set_config('mbs.social_account', p_social_account_id::text, true);
  v_filed := public.file_social_comment(p_tenant_id, p_channel, p_external_id, p_name, p_handle,
    p_comment_id, p_parent_id, p_post_external_id, p_body, p_summary, p_subject, p_sent_at,
    p_start, p_tags);
  perform private.claim_filed_for_account(p_tenant_id, p_social_account_id, v_filed);
  return v_filed;
end;
$$;

-- Which account a conversation is answered as (service role): the one it
-- came to, or, for one from before accounts that somehow has none, the
-- account in use on its channel through the connection's own Page.
create function public.social_ticket_account(p_tenant_id uuid, p_ticket_id uuid)
returns table (
  social_account_id uuid, network text, platform_id text, page_id text, handle text,
  name text, tasks text[], active boolean, brand_id uuid
)
language sql stable security definer set search_path = ''
as $$
  select a.id, a.network, a.platform_id, a.page_id, a.handle, a.name, a.tasks, a.active, a.brand_id
  from public.tickets t
  join public.social_accounts a on a.tenant_id = t.tenant_id and a.network = t.channel
  left join public.connections c on c.tenant_id = t.tenant_id and c.provider = 'meta'
  where t.id = p_ticket_id and t.tenant_id = p_tenant_id and t.channel <> 'email'
    and (a.id = t.social_account_id or (t.social_account_id is null and a.active))
  order by (a.id = t.social_account_id) desc nulls last,
           (a.page_id = c.external_account_id) desc nulls last, a.created_at
  limit 1;
$$;

-- What the automatic first reply knows. As before, except that
-- {{business_name}} is the brand's name for a conversation that came to an
-- account of a brand other than the main one (fixed words still; filled in
-- by code). Same columns.
create or replace function public.auto_reply_facts(p_tenant_id uuid, p_message_id uuid)
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
         coalesce((select b.name from public.social_accounts s
                   join public.brands b on b.id = s.brand_id
                   where s.id = t.social_account_id and not b.is_default), w.name),
         w.timezone
  from public.messages m
  join public.tickets t on t.id = m.ticket_id
  join public.contacts c on c.id = t.contact_id
  join public.tenants w on w.id = t.tenant_id
  where m.id = p_message_id and m.tenant_id = p_tenant_id and t.tenant_id = p_tenant_id
    and t.merged_into is null;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.file_account_message(uuid, uuid, text, text, text, text, text, text, text, timestamptz, text[])',
    'public.file_account_comment(uuid, uuid, text, text, text, text, text, text, text, text, text, text, timestamptz, boolean, text[])',
    'public.social_ticket_account(uuid, uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Existing conversations, people and posts, in place: each is given its
-- channel's account on the workspace's connection (the connection's own Page
-- for Facebook, the Instagram account linked to it for Instagram). Only the
-- new column is written; the triggers that watch other columns are held so
-- nothing else (activity log, updated_at) moves.
-- ---------------------------------------------------------------------------

alter table public.tickets disable trigger user;
update public.tickets t
set social_account_id = a.id
from public.connections c
join public.social_accounts a on a.connection_id = c.id and a.page_id = c.external_account_id
where c.tenant_id = t.tenant_id and c.provider = 'meta'
  and t.channel <> 'email' and t.social_account_id is null and a.network = t.channel;
alter table public.tickets enable trigger user;

alter table public.contacts disable trigger user;
update public.contacts p
set social_account_id = a.id
from public.connections c
join public.social_accounts a on a.connection_id = c.id and a.page_id = c.external_account_id
where c.tenant_id = p.tenant_id and c.provider = 'meta'
  and p.channel <> 'email' and p.social_account_id is null and a.network = p.channel;
alter table public.contacts enable trigger user;

alter table public.comment_posts disable trigger user;
update public.comment_posts p
set social_account_id = a.id
from public.connections c
join public.social_accounts a on a.connection_id = c.id and a.page_id = c.external_account_id
where c.tenant_id = p.tenant_id and c.provider = 'meta'
  and p.social_account_id is null and a.network = p.channel;
alter table public.comment_posts enable trigger user;
