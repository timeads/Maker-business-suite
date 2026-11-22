-- Messages: team chat inside a workspace.
-- Channels everyone in the workspace can see, one-to-one direct messages,
-- read positions for unread counts, and posts from the other tools.
-- Members read under row-level security; every write goes through a function.

alter table public.memberships add column display_name text
  check (display_name is null or char_length(btrim(display_name)) between 1 and 40);

create table public.chat_channels (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  kind text not null check (kind in ('channel', 'dm')),
  -- Channels have a name; a direct message has the pair's key instead.
  name text check (name ~ '^[a-z0-9][a-z0-9-]{1,29}$'),
  topic text not null default '' check (char_length(topic) <= 120),
  dm_key text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  check ((kind = 'channel' and name is not null and dm_key is null)
      or (kind = 'dm' and name is null and dm_key is not null)),
  unique (tenant_id, name),
  unique (tenant_id, dm_key)
);

create table public.chat_members (
  channel_id uuid not null references public.chat_channels (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  primary key (channel_id, user_id)
);
create index chat_members_user_idx on public.chat_members (user_id);

create table public.chat_messages (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  channel_id uuid not null references public.chat_channels (id) on delete cascade,
  -- A person, or one of the workspace's own tools (then `app` names it).
  author_id uuid references auth.users (id) on delete set null,
  app text check (app is null or app ~ '^[a-z]{2,20}$'),
  body text not null check (char_length(body) <= 4000),
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz
);
create index chat_messages_channel_idx on public.chat_messages (channel_id, id);

create table public.chat_reads (
  channel_id uuid not null references public.chat_channels (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  last_read_id bigint not null default 0,
  primary key (channel_id, user_id)
);

-- Whether the caller may see a conversation: any channel in their workspace,
-- and only the direct messages they are part of.
create function private.can_see_chat(p_channel_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.chat_channels c
    where c.id = p_channel_id
      and c.tenant_id in (select private.user_tenant_ids())
      and (c.kind = 'channel' or exists (
        select 1 from public.chat_members m
        where m.channel_id = c.id and m.user_id = auth.uid()))
  );
$$;
revoke all on function private.can_see_chat(uuid) from public;
grant execute on function private.can_see_chat(uuid) to authenticated;

alter table public.chat_channels enable row level security;
alter table public.chat_members enable row level security;
alter table public.chat_messages enable row level security;
alter table public.chat_reads enable row level security;

create policy "members see their conversations" on public.chat_channels
  for select to authenticated using (private.can_see_chat(id));
create policy "members see who is in their direct messages" on public.chat_members
  for select to authenticated using (private.can_see_chat(channel_id));
create policy "members read messages in their conversations" on public.chat_messages
  for select to authenticated using (private.can_see_chat(channel_id));
create policy "people see their own read positions" on public.chat_reads
  for select to authenticated using (user_id = auth.uid());

revoke all on public.chat_channels, public.chat_members, public.chat_messages, public.chat_reads
  from public, anon, authenticated, service_role;
grant select on public.chat_channels, public.chat_members, public.chat_messages, public.chat_reads
  to authenticated, service_role;

-- New and changed messages are announced live to the people allowed to read them.
alter publication supabase_realtime add table public.chat_messages;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create function private.require_member(p_tenant_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_tenant_id is null or not (p_tenant_id in (select private.user_tenant_ids())) then
    raise exception 'Workspace not found' using errcode = '42501';
  end if;
end;
$$;
revoke all on function private.require_member(uuid) from public;

create function private.ensure_default_channels(p_tenant_id uuid)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.chat_channels (tenant_id, kind, name, topic)
  values (p_tenant_id, 'channel', 'general', 'Everything and anything'),
         (p_tenant_id, 'channel', 'alerts', 'Heads-ups from your tools')
  on conflict (tenant_id, name) do nothing;
$$;
revoke all on function private.ensure_default_channels(uuid) from public;

-- ---------------------------------------------------------------------------
-- What members do
-- ---------------------------------------------------------------------------

-- Everyone in the workspace, with the name to show for them.
create function public.chat_people(p_tenant_id uuid)
returns table (user_id uuid, email text, display_name text)
language sql stable security definer set search_path = ''
as $$
  select m.user_id, u.email::text, m.display_name
  from public.memberships m
  join auth.users u on u.id = m.user_id
  where m.tenant_id = p_tenant_id
    and p_tenant_id in (select private.user_tenant_ids())
  order by m.created_at;
$$;

create function public.set_display_name(p_tenant_id uuid, p_name text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_member(p_tenant_id);
  update public.memberships m set display_name = nullif(btrim(p_name), '')
  where m.tenant_id = p_tenant_id and m.user_id = auth.uid();
end;
$$;

-- The caller's conversations with how many messages they haven't read.
-- Creates the two starting channels the first time anyone opens Messages.
create function public.chat_overview(p_tenant_id uuid)
returns table (
  channel_id uuid, kind text, name text, topic text, other_user_id uuid,
  unread bigint, last_message_id bigint
)
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_member(p_tenant_id);
  perform private.ensure_default_channels(p_tenant_id);
  return query
    select c.id, c.kind, c.name, c.topic,
           (select m.user_id from public.chat_members m
            where m.channel_id = c.id and m.user_id <> auth.uid() limit 1),
           (select count(*) from public.chat_messages msg
            where msg.channel_id = c.id and msg.deleted_at is null
              and msg.author_id is distinct from auth.uid()
              and msg.id > coalesce((select r.last_read_id from public.chat_reads r
                                     where r.channel_id = c.id and r.user_id = auth.uid()), 0)),
           (select max(msg.id) from public.chat_messages msg where msg.channel_id = c.id)
    from public.chat_channels c
    where c.tenant_id = p_tenant_id
      and (c.kind = 'channel' or exists (
        select 1 from public.chat_members m
        where m.channel_id = c.id and m.user_id = auth.uid()))
    order by c.kind, (c.name = 'alerts'), c.name, c.created_at;
end;
$$;

create function public.create_chat_channel(p_tenant_id uuid, p_name text, p_topic text default '')
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_member(p_tenant_id);
  insert into public.chat_channels (tenant_id, kind, name, topic, created_by)
  values (p_tenant_id, 'channel', lower(btrim(p_name)), left(btrim(coalesce(p_topic, '')), 120), auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

-- Opens (or finds) the one-to-one conversation with another member.
create function public.open_chat_dm(p_tenant_id uuid, p_other_user_id uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_key text;
begin
  perform private.require_member(p_tenant_id);
  if not exists (
    select 1 from public.memberships m
    where m.tenant_id = p_tenant_id and m.user_id = p_other_user_id
  ) then
    raise exception 'That person is not in this workspace' using errcode = 'P0002';
  end if;
  v_key := least(auth.uid()::text, p_other_user_id::text) || '|' ||
           greatest(auth.uid()::text, p_other_user_id::text);
  insert into public.chat_channels (tenant_id, kind, dm_key, created_by)
  values (p_tenant_id, 'dm', v_key, auth.uid())
  on conflict (tenant_id, dm_key) do update set dm_key = excluded.dm_key
  returning id into v_id;
  insert into public.chat_members (channel_id, tenant_id, user_id)
  values (v_id, p_tenant_id, auth.uid()), (v_id, p_tenant_id, p_other_user_id)
  on conflict do nothing;
  return v_id;
end;
$$;

create function public.post_chat_message(p_channel_id uuid, p_body text)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant uuid;
  v_id bigint;
  v_body text := btrim(coalesce(p_body, ''));
begin
  if not private.can_see_chat(p_channel_id) then
    raise exception 'Conversation not found' using errcode = 'P0002';
  end if;
  if v_body = '' then
    raise exception 'A message needs some words in it' using errcode = '22023';
  end if;
  select c.tenant_id into v_tenant from public.chat_channels c where c.id = p_channel_id;
  insert into public.chat_messages (tenant_id, channel_id, author_id, body)
  values (v_tenant, p_channel_id, auth.uid(), v_body)
  returning id into v_id;
  -- You've read your own message.
  insert into public.chat_reads (channel_id, tenant_id, user_id, last_read_id)
  values (p_channel_id, v_tenant, auth.uid(), v_id)
  on conflict (channel_id, user_id) do update
    set last_read_id = greatest(public.chat_reads.last_read_id, excluded.last_read_id);
  return v_id;
end;
$$;

-- Only the author can change or remove a message. Removing keeps the row so
-- the conversation doesn't lose its shape.
create function public.edit_chat_message(p_message_id bigint, p_body text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if btrim(coalesce(p_body, '')) = '' then
    raise exception 'A message needs some words in it' using errcode = '22023';
  end if;
  update public.chat_messages m set body = btrim(p_body), edited_at = now()
  where m.id = p_message_id and m.author_id = auth.uid() and m.deleted_at is null;
  if not found then
    raise exception 'Message not found' using errcode = 'P0002';
  end if;
end;
$$;

create function public.delete_chat_message(p_message_id bigint)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.chat_messages m set body = '', deleted_at = now()
  where m.id = p_message_id and m.author_id = auth.uid() and m.deleted_at is null;
  if not found then
    raise exception 'Message not found' using errcode = 'P0002';
  end if;
end;
$$;

-- Read positions only ever move forward.
create function public.mark_chat_read(p_channel_id uuid, p_last_read_id bigint)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  if not private.can_see_chat(p_channel_id) then
    return;
  end if;
  select c.tenant_id into v_tenant from public.chat_channels c where c.id = p_channel_id;
  insert into public.chat_reads (channel_id, tenant_id, user_id, last_read_id)
  values (p_channel_id, v_tenant, auth.uid(), greatest(coalesce(p_last_read_id, 0), 0))
  on conflict (channel_id, user_id) do update
    set last_read_id = greatest(public.chat_reads.last_read_id, excluded.last_read_id);
end;
$$;

revoke all on function public.chat_people(uuid) from public, anon;
revoke all on function public.set_display_name(uuid, text) from public, anon;
revoke all on function public.chat_overview(uuid) from public, anon;
revoke all on function public.create_chat_channel(uuid, text, text) from public, anon;
revoke all on function public.open_chat_dm(uuid, uuid) from public, anon;
revoke all on function public.post_chat_message(uuid, text) from public, anon;
revoke all on function public.edit_chat_message(bigint, text) from public, anon;
revoke all on function public.delete_chat_message(bigint) from public, anon;
revoke all on function public.mark_chat_read(uuid, bigint) from public, anon;
grant execute on function public.chat_people(uuid) to authenticated;
grant execute on function public.set_display_name(uuid, text) to authenticated;
grant execute on function public.chat_overview(uuid) to authenticated;
grant execute on function public.create_chat_channel(uuid, text, text) to authenticated;
grant execute on function public.open_chat_dm(uuid, uuid) to authenticated;
grant execute on function public.post_chat_message(uuid, text) to authenticated;
grant execute on function public.edit_chat_message(bigint, text) to authenticated;
grant execute on function public.delete_chat_message(bigint) to authenticated;
grant execute on function public.mark_chat_read(uuid, bigint) to authenticated;

-- ---------------------------------------------------------------------------
-- Posts from the workspace's own tools (service role only)
-- ---------------------------------------------------------------------------

create function public.post_app_chat_message(
  p_tenant_id uuid, p_channel text, p_app text, p_body text
)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_channel uuid;
  v_id bigint;
begin
  perform private.ensure_default_channels(p_tenant_id);
  select c.id into v_channel from public.chat_channels c
  where c.tenant_id = p_tenant_id and c.kind = 'channel' and c.name = coalesce(p_channel, 'alerts');
  if v_channel is null then
    select c.id into v_channel from public.chat_channels c
    where c.tenant_id = p_tenant_id and c.kind = 'channel' and c.name = 'alerts';
  end if;
  insert into public.chat_messages (tenant_id, channel_id, app, body)
  values (p_tenant_id, v_channel, p_app, left(btrim(p_body), 4000))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.post_app_chat_message(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.post_app_chat_message(uuid, text, text, text) to service_role;
