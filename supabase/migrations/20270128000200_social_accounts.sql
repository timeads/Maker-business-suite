-- Social accounts: one Facebook login can now hold several Pages, each with
-- the Instagram professional account linked to it, and each account is used
-- (or not) and belongs to a brand on its own.
--
-- What Meta's login offered is written here by the server (service role,
-- `note_meta_accounts`); which of them the workspace uses, and as which
-- brand, is an owner's or admin's choice (`choose_social_accounts`). No token
-- is ever stored here: each Page's token sits in Vault with the rest of the
-- connection's, read only through the token accessor, which now names the
-- account (`getMetaAccountToken`).
--
-- `network` is the platform ('facebook', 'instagram' today). Another network
-- is a further value in the check below, plus its own rows: nothing else in
-- this table is about Meta except `page_id` (the Page an Instagram account
-- goes through) and `tasks` (what Meta says the person may do on that Page).
--
-- Existing workspaces are moved across in place at the end of this file:
-- their one Page and its Instagram account become two accounts in use, on
-- their main brand.

create table public.social_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  connection_id uuid references public.connections (id) on delete set null,
  brand_id uuid not null references public.brands (id) on delete restrict,
  network text not null check (network in ('facebook', 'instagram')),
  -- The platform's own id for the account: a Page id, an Instagram account id.
  platform_id text not null check (char_length(platform_id) between 1 and 200),
  -- The Facebook Page it is reached through (itself, for a Page).
  page_id text check (page_id is null or char_length(page_id) between 1 and 200),
  name text check (name is null or char_length(name) <= 200),
  -- An Instagram username, without the "@".
  handle text check (handle is null or handle ~ '^[A-Za-z0-9._]{1,30}$'),
  -- What Meta says the person who logged in may do on the Page ("MANAGE",
  -- "CREATE_CONTENT", "MESSAGING", "MODERATE", ...). Null: Meta didn't say.
  tasks text[],
  -- In use by this workspace: posts can go to it and its messages are filed.
  active boolean not null default false,
  -- Meta's latest login still shared it (an account it stopped sharing can't be used).
  offered boolean not null default true,
  -- In use when its connection was disconnected: used again once it is reconnected.
  paused boolean not null default false,
  chosen_by uuid references auth.users (id) on delete set null,
  chosen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, network, platform_id),
  check (not active or offered)
);
-- One workspace at a time uses an account: deliveries are routed by it.
create unique index social_accounts_one_live_idx
  on public.social_accounts (network, platform_id) where active;
create index social_accounts_tenant_idx on public.social_accounts (tenant_id, network);
create index social_accounts_brand_idx on public.social_accounts (brand_id);

alter table public.social_accounts enable row level security;
create policy "members read their social accounts" on public.social_accounts
  for select to authenticated
  using (tenant_id in (select private.user_tenant_ids()));
revoke all on public.social_accounts from public, anon, authenticated, service_role;
grant select on public.social_accounts to authenticated, service_role;

create trigger social_accounts_touch_updated_at
  before update on public.social_accounts
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Per-account permission: Meta grants permissions to the login, but says per
-- Page what the person may do there. The same rule as `accountAllows` in
-- src/lib/connections/meta-access.ts (a test keeps them in step).
-- ---------------------------------------------------------------------------

create function private.meta_tasks_allow(p_tasks text[], p_use text)
returns boolean
language sql immutable set search_path = ''
as $$
  select p_tasks is null
      or 'MANAGE' = any (p_tasks)
      or case p_use
           when 'posting' then 'CREATE_CONTENT' = any (p_tasks)
           when 'messages' then 'MESSAGING' = any (p_tasks)
           when 'comments' then 'MODERATE' = any (p_tasks)
           else false
         end;
$$;
revoke all on function private.meta_tasks_allow(text[], text) from public;

-- ---------------------------------------------------------------------------
-- Routing: which workspace, and which of its accounts, a delivery is for.
-- `p_for` is 'messages' or 'comments'. Only an account in use, on a live
-- connection granted that use's permissions, allowed on its Page, in a
-- workspace that switched the channel on, counts. Anything else is dropped.
-- ---------------------------------------------------------------------------

create function private.meta_account_route(p_object text, p_account_id text, p_for text)
returns table (
  tenant_id uuid, connection_id uuid, channel text, page_id text, own_handle text,
  social_account_id uuid, brand_id uuid
)
language sql stable security definer set search_path = ''
as $$
  select a.tenant_id, c.id, w.channel, a.page_id, a.handle, a.id, a.brand_id
  from (select case p_object when 'instagram' then 'instagram' when 'page' then 'facebook' end as channel) w
  join public.social_accounts a
    on a.network = w.channel and a.platform_id = p_account_id and a.active
  join public.connections c
    on c.id = a.connection_id and c.tenant_id = a.tenant_id
   and c.provider = 'meta' and c.status = 'active'
  where p_account_id is not null and p_account_id <> ''
    and a.page_id is not null
    and case p_for
          when 'messages' then
            c.scopes @> array['pages_manage_metadata']
            and case w.channel
                  when 'facebook' then c.scopes @> array['pages_messaging']
                  else c.scopes @> array['instagram_manage_messages', 'instagram_basic']
                end
            and private.meta_tasks_allow(a.tasks, 'messages')
          when 'comments' then
            c.scopes @> array['pages_manage_metadata', 'pages_read_engagement']
            and case w.channel
                  when 'facebook' then c.scopes @> array['pages_read_user_content']
                  else c.scopes @> array['instagram_manage_comments', 'instagram_basic']
                end
            and private.meta_tasks_allow(a.tasks, 'comments')
          else false
        end
    and exists (
      select 1 from public.configs g
      where g.tenant_id = a.tenant_id and g.module = 'helpdesk' and g.key = 'channels'
        and jsonb_typeof(g.body -> (w.channel || case when p_for = 'comments' then '_comments' else '' end)) = 'boolean'
        and (g.body ->> (w.channel || case when p_for = 'comments' then '_comments' else '' end))::boolean
    )
  limit 1;
$$;
revoke all on function private.meta_account_route(text, text, text) from public;

-- The two older lookups now go by the accounts too, so `enqueue_meta_event`
-- ("drops what no workspace has connected") and the worker's old calls keep
-- working unchanged. Same columns as before.
create or replace function private.meta_channel(p_object text, p_account_id text)
returns table (tenant_id uuid, connection_id uuid, channel text, page_id text)
language sql stable security definer set search_path = ''
as $$
  select r.tenant_id, r.connection_id, r.channel, r.page_id
  from private.meta_account_route(p_object, p_account_id, 'messages') r;
$$;

create or replace function private.meta_comment_channel(p_object text, p_account_id text)
returns table (tenant_id uuid, connection_id uuid, channel text, page_id text, own_handle text)
language sql stable security definer set search_path = ''
as $$
  select r.tenant_id, r.connection_id, r.channel, r.page_id, r.own_handle
  from private.meta_account_route(p_object, p_account_id, 'comments') r;
$$;

-- For the worker: whose a delivery is, down to the account. Service role only.
create function public.resolve_meta_account(p_object text, p_account_id text, p_for text)
returns table (
  tenant_id uuid, connection_id uuid, channel text, page_id text, own_handle text,
  social_account_id uuid, brand_id uuid
)
language sql stable security definer set search_path = ''
as $$
  select * from private.meta_account_route(p_object, p_account_id, p_for);
$$;

-- ---------------------------------------------------------------------------
-- What Meta's login offered (the server, after Facebook's login)
-- ---------------------------------------------------------------------------

-- `p_accounts` is [{network, platform_id, page_id, name, handle, tasks}], every
-- Page (and its Instagram account) the person shared. Known accounts get
-- their names and tasks refreshed and keep the workspace's choices; new ones
-- arrive unused; ones no longer shared can't be used any more (their rows,
-- and whatever points at them, stay). A workspace using no account at all
-- (its first login) starts using the first Page with an Instagram account,
-- and that account, on its main brand: what a login always did before.
create function public.note_meta_accounts(p_tenant_id uuid, p_accounts jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_connection uuid;
  v_brand uuid;
  v_item jsonb;
  v_offered text[] := '{}';
  v_first text;
  v_started int := 0;
begin
  if jsonb_typeof(coalesce(p_accounts, 'null'::jsonb)) <> 'array' then
    raise exception 'That list is not valid' using errcode = '22023';
  end if;
  select c.id into v_connection from public.connections c
  where c.tenant_id = p_tenant_id and c.provider = 'meta';
  if v_connection is null then
    raise exception 'Not connected' using errcode = 'P0002';
  end if;
  perform 1 from public.tenants t where t.id = p_tenant_id for update;
  v_brand := private.ensure_default_brand(p_tenant_id);

  for v_item in select * from jsonb_array_elements(p_accounts) loop
    continue when v_item ->> 'network' not in ('facebook', 'instagram')
      or coalesce(v_item ->> 'platform_id', '') = '' or coalesce(v_item ->> 'page_id', '') = '';
    v_offered := v_offered || (v_item ->> 'network' || ':' || (v_item ->> 'platform_id'));
    insert into public.social_accounts
      (tenant_id, connection_id, brand_id, network, platform_id, page_id, name, handle, tasks, offered)
    values (
      p_tenant_id, v_connection, v_brand, v_item ->> 'network', v_item ->> 'platform_id',
      v_item ->> 'page_id', left(nullif(btrim(coalesce(v_item ->> 'name', '')), ''), 200),
      case when v_item ->> 'handle' ~ '^[A-Za-z0-9._]{1,30}$' then v_item ->> 'handle' end,
      case when jsonb_typeof(v_item -> 'tasks') = 'array'
           then array(select upper(t) from jsonb_array_elements_text(v_item -> 'tasks') t
                      where t ~ '^[A-Za-z_]{1,40}$') end,
      true)
    on conflict (tenant_id, network, platform_id) do update
      set connection_id = excluded.connection_id, page_id = excluded.page_id,
          name = coalesce(excluded.name, public.social_accounts.name),
          handle = coalesce(excluded.handle, public.social_accounts.handle),
          tasks = excluded.tasks, offered = true;
  end loop;

  -- No longer shared with us: out of use, kept.
  update public.social_accounts a
  set offered = false, active = false
  where a.tenant_id = p_tenant_id and a.connection_id = v_connection
    and not ((a.network || ':' || a.platform_id) = any (v_offered));

  if not exists (select 1 from public.social_accounts a where a.tenant_id = p_tenant_id and a.active) then
    select a.page_id into v_first
    from public.social_accounts a
    where a.tenant_id = p_tenant_id and a.offered and a.network = 'facebook'
      and not exists (select 1 from public.social_accounts o
                      where o.network = a.network and o.platform_id = a.platform_id and o.active)
    order by exists (select 1 from public.social_accounts i
                     where i.tenant_id = a.tenant_id and i.network = 'instagram'
                       and i.page_id = a.page_id and i.offered) desc,
             array_position(v_offered, 'facebook:' || a.platform_id)
    limit 1;
    if v_first is not null then
      update public.social_accounts a
      set active = true, brand_id = v_brand, chosen_at = now()
      where a.tenant_id = p_tenant_id and a.page_id = v_first and a.offered
        and not exists (select 1 from public.social_accounts o
                        where o.network = a.network and o.platform_id = a.platform_id and o.active);
      get diagnostics v_started = row_count;
    end if;
  end if;

  return jsonb_build_object(
    'offered', cardinality(v_offered),
    'started', v_started,
    'waiting', (select count(*) from public.social_accounts a
                where a.tenant_id = p_tenant_id and a.offered and not a.active and a.chosen_at is null));
end;
$$;

-- ---------------------------------------------------------------------------
-- What owners and admins choose
-- ---------------------------------------------------------------------------

-- `p_choices` is [{id, active, brand_id}]: which accounts are in use and the
-- brand each posts and answers as. Accounts not named are left as they are,
-- so adding or removing one never disturbs the others. The plan's limit per
-- network is the server's to check; the database holds a ceiling.
create function public.choose_social_accounts(p_tenant_id uuid, p_choices jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_item jsonb;
  v_account public.social_accounts;
  v_brand uuid;
  v_active boolean;
begin
  perform private.require_manager(p_tenant_id);
  if jsonb_typeof(coalesce(p_choices, 'null'::jsonb)) <> 'array' then
    raise exception 'That list is not valid' using errcode = '22023';
  end if;
  perform 1 from public.tenants t where t.id = p_tenant_id for update;
  for v_item in select * from jsonb_array_elements(p_choices) loop
    select * into v_account from public.social_accounts a
    where a.id::text = v_item ->> 'id' and a.tenant_id = p_tenant_id
    for update;
    if not found then
      raise exception 'Account not found' using errcode = 'P0002';
    end if;
    v_active := coalesce((v_item ->> 'active')::boolean, v_account.active);
    v_brand := coalesce(nullif(v_item ->> 'brand_id', '')::uuid, v_account.brand_id);
    if not exists (
      select 1 from public.brands b
      where b.id = v_brand and b.tenant_id = p_tenant_id
        and (b.archived_at is null or (b.id = v_account.brand_id and not v_active))
    ) then
      raise exception 'Brand not found' using errcode = 'P0002';
    end if;
    if v_active and not v_account.offered then
      raise exception 'not_offered' using errcode = 'P0001';
    end if;
    if v_active and not v_account.active and exists (
      select 1 from public.social_accounts o
      where o.network = v_account.network and o.platform_id = v_account.platform_id
        and o.active and o.id <> v_account.id
    ) then
      raise exception 'in_use' using errcode = 'P0001';
    end if;
    update public.social_accounts a
    set active = v_active, brand_id = v_brand,
        chosen_by = auth.uid(), chosen_at = now()
    where a.id = v_account.id;
  end loop;
  if exists (
    select 1 from public.social_accounts a
    where a.tenant_id = p_tenant_id and a.active
    group by a.network having count(*) > 50
  ) then
    raise exception 'too_many_accounts' using errcode = 'P0001';
  end if;
  perform private.log_audit(p_tenant_id, 'social.accounts_chosen', 'social_accounts', null);
end;
$$;

-- A brand that accounts post as can't be put away until they are moved.
create or replace function public.archive_brand(p_tenant_id uuid, p_brand_id uuid, p_archived boolean default true)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_brand public.brands;
begin
  perform private.require_manager(p_tenant_id);
  select * into v_brand from public.brands b
  where b.id = p_brand_id and b.tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'Brand not found' using errcode = 'P0002';
  end if;
  if p_archived and v_brand.is_default then
    raise exception 'default_brand' using errcode = 'P0001';
  end if;
  if p_archived and exists (
    select 1 from public.social_accounts a where a.brand_id = v_brand.id and a.active
  ) then
    raise exception 'has_accounts' using errcode = 'P0001';
  end if;
  update public.brands b
  set archived_at = case when p_archived then coalesce(b.archived_at, now()) end
  where b.id = v_brand.id;
  perform private.log_audit(p_tenant_id, case when p_archived then 'brand.archived' else 'brand.restored' end,
    'brand', p_brand_id::text);
end;
$$;

do $$
declare
  fn text;
begin
  execute 'revoke all on function public.choose_social_accounts(uuid, jsonb) from public, anon';
  execute 'grant execute on function public.choose_social_accounts(uuid, jsonb) to authenticated';
  foreach fn in array array[
    'public.resolve_meta_account(text, text, text)',
    'public.note_meta_accounts(uuid, jsonb)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Kept in step with the connection row itself, whoever writes it. The
-- connection's own Page (and its Instagram account) are always among the
-- accounts offered; a workspace using none starts using them, as a login
-- always did before. Disconnecting puts the accounts in use aside, and
-- reconnecting brings them back, unless another workspace took one since.
-- ---------------------------------------------------------------------------

create function private.meta_connection_accounts()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_brand uuid;
  v_ig text := nullif(new.metadata ->> 'instagram_id', '');
  v_name text := nullif(split_part(coalesce(new.display_name, ''), ' · ', 1), '');
begin
  if new.provider <> 'meta' then
    return new;
  end if;
  if new.status = 'disconnected' then
    update public.social_accounts a set paused = true, active = false
    where a.connection_id = new.id and a.active;
    return new;
  end if;
  v_brand := private.ensure_default_brand(new.tenant_id);
  insert into public.social_accounts
    (tenant_id, connection_id, brand_id, network, platform_id, page_id, name, offered)
  values (new.tenant_id, new.id, v_brand, 'facebook', new.external_account_id,
          new.external_account_id, v_name, true)
  on conflict (tenant_id, network, platform_id) do update
    set connection_id = excluded.connection_id, page_id = excluded.page_id,
        name = coalesce(excluded.name, public.social_accounts.name), offered = true;
  if v_ig is not null then
    insert into public.social_accounts
      (tenant_id, connection_id, brand_id, network, platform_id, page_id, name, handle, offered)
    values (new.tenant_id, new.id, v_brand, 'instagram', v_ig, new.external_account_id, v_name,
            case when new.metadata ->> 'instagram_username' ~ '^[A-Za-z0-9._]{1,30}$'
                 then new.metadata ->> 'instagram_username' end,
            true)
    on conflict (tenant_id, network, platform_id) do update
      set connection_id = excluded.connection_id, page_id = excluded.page_id,
          name = coalesce(excluded.name, public.social_accounts.name),
          handle = coalesce(excluded.handle, public.social_accounts.handle), offered = true;
  end if;
  -- Back from a disconnect: what was in use is in use again.
  update public.social_accounts a set active = true, paused = false
  where a.connection_id = new.id and a.paused and a.offered
    and not exists (select 1 from public.social_accounts o
                    where o.network = a.network and o.platform_id = a.platform_id and o.active);
  update public.social_accounts a set paused = false
  where a.connection_id = new.id and a.paused;
  if not exists (select 1 from public.social_accounts a where a.tenant_id = new.tenant_id and a.active) then
    update public.social_accounts a set active = true, chosen_at = coalesce(a.chosen_at, now())
    where a.tenant_id = new.tenant_id and a.page_id = new.external_account_id and a.offered
      and not exists (select 1 from public.social_accounts o
                      where o.network = a.network and o.platform_id = a.platform_id and o.active);
  end if;
  return new;
end;
$$;
revoke all on function private.meta_connection_accounts() from public;
create trigger connections_meta_accounts
  after insert or update of external_account_id, display_name, metadata, status on public.connections
  for each row execute function private.meta_connection_accounts();

-- ---------------------------------------------------------------------------
-- Existing workspaces, in place: the connection's one Page, and the Instagram
-- account linked to it, become two accounts in use on the main brand. A
-- disconnected connection's accounts are kept, out of use, so its old posts
-- and conversations still name them.
-- ---------------------------------------------------------------------------

do $$
declare
  v_c public.connections;
  v_brand uuid;
  v_live boolean;
  v_ig text;
begin
  for v_c in select * from public.connections c where c.provider = 'meta' order by c.created_at loop
    v_brand := private.ensure_default_brand(v_c.tenant_id);
    v_live := v_c.status <> 'disconnected';
    insert into public.social_accounts
      (tenant_id, connection_id, brand_id, network, platform_id, page_id, name, active, offered, chosen_at)
    values (
      v_c.tenant_id, v_c.id, v_brand, 'facebook', v_c.external_account_id, v_c.external_account_id,
      nullif(split_part(coalesce(v_c.display_name, ''), ' · ', 1), ''),
      v_live and not exists (select 1 from public.social_accounts o
                             where o.network = 'facebook' and o.platform_id = v_c.external_account_id
                               and o.active),
      v_live, v_c.created_at)
    on conflict (tenant_id, network, platform_id) do nothing;
    v_ig := nullif(v_c.metadata ->> 'instagram_id', '');
    if v_ig is not null then
      insert into public.social_accounts
        (tenant_id, connection_id, brand_id, network, platform_id, page_id, name, handle, active, offered, chosen_at)
      values (
        v_c.tenant_id, v_c.id, v_brand, 'instagram', v_ig, v_c.external_account_id,
        nullif(split_part(coalesce(v_c.display_name, ''), ' · ', 1), ''),
        case when v_c.metadata ->> 'instagram_username' ~ '^[A-Za-z0-9._]{1,30}$'
             then v_c.metadata ->> 'instagram_username' end,
        v_live and not exists (select 1 from public.social_accounts o
                               where o.network = 'instagram' and o.platform_id = v_ig and o.active),
        v_live, v_c.created_at)
      on conflict (tenant_id, network, platform_id) do nothing;
    end if;
  end loop;
end;
$$;
