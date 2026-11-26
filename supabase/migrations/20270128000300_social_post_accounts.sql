-- Social posts name the brand they are drawn in and the ACCOUNTS they go to.
--
-- `channels` stays what it was: the places a post goes ('facebook',
-- 'instagram' for the feed or a Reel, 'instagram_story'), so every rule that
-- reads it (what can be scheduled, photo sizes, slides, Stories) is
-- unchanged. `account_ids` says which accounts: each account gets the places
-- of its own network. One target is "<account id>:<place>", and a target's
-- answer is kept under that name in `results`, so `finish_social_post` merges
-- answers per account: an account that went out is never sent twice, and one
-- that failed can be tried again by itself (`retry_social_post`).
--
-- A caption of its own is per ACCOUNT now (`captions` keyed by account id,
-- only where the words differ); a caption keyed by a place, as before, still
-- counts for every account of that place.
--
-- `save_social_post_to` saves a post with its brand and accounts. It calls
-- `save_social_post_full`, which calls `save_social_post`, so they still own
-- every rule about what can be scheduled or changed. A caller that names no
-- accounts (the older functions) gets the brand's accounts in use for the
-- places it named, so nothing changes for a workspace with one Page.
--
-- Existing posts are moved across in place at the end of this file.

alter table public.social_posts
  add column brand_id uuid references public.brands (id) on delete restrict,
  add column account_ids uuid[] not null default '{}'
    check (cardinality(account_ids) <= 20);
create index social_posts_brand_idx on public.social_posts (tenant_id, brand_id);

-- Which network a place belongs to.
create function private.social_place_network(p_place text)
returns text
language sql immutable set search_path = ''
as $$
  select case p_place when 'facebook' then 'facebook'
                      when 'instagram' then 'instagram'
                      when 'instagram_story' then 'instagram' end;
$$;
revoke all on function private.social_place_network(text) from public;

-- Where a post goes, one "<account id>:<place>" per account and place of its
-- network, in the post's order. A post naming no accounts goes to its places
-- by their bare names, as before.
create function private.social_post_targets(p_tenant_id uuid, p_account_ids uuid[], p_channels text[])
returns text[]
language sql stable security definer set search_path = ''
as $$
  select case when cardinality(coalesce(p_account_ids, '{}')) = 0 then coalesce(p_channels, '{}')
  else coalesce((
    select array_agg(a.id::text || ':' || c.place
                     order by array_position(p_account_ids, a.id), c.n)
    from public.social_accounts a
    cross join unnest(coalesce(p_channels, '{}')) with ordinality as c(place, n)
    where a.tenant_id = p_tenant_id and a.id = any (p_account_ids)
      and a.network = private.social_place_network(c.place)
  ), '{}') end;
$$;
revoke all on function private.social_post_targets(uuid, uuid[], text[]) from public;

-- ---------------------------------------------------------------------------
-- Brand and accounts on every save
-- ---------------------------------------------------------------------------

-- Fills in the brand (the main one) and, for a caller that named no
-- accounts, the brand's accounts in use for the post's places. Inside
-- `save_social_post_to` the brand and accounts it was handed are used
-- instead. A post going out, or out, is never touched.
create function private.social_post_accounts_fill()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_given text := nullif(current_setting('mbs.social_post_to', true), '');
begin
  if tg_op = 'UPDATE' and old.status in ('publishing', 'published') then
    return new;
  end if;
  if v_given is not null then
    new.brand_id := (v_given::jsonb ->> 'brand_id')::uuid;
    new.account_ids := array(select jsonb_array_elements_text(v_given::jsonb -> 'account_ids'))::uuid[];
    return new;
  end if;
  if new.brand_id is null then
    new.brand_id := private.ensure_default_brand(new.tenant_id);
  end if;
  if cardinality(new.channels) > 0
     and (cardinality(new.account_ids) = 0
          or (tg_op = 'UPDATE' and new.channels is distinct from old.channels)) then
    new.account_ids := array(
      select a.id from public.social_accounts a
      where a.tenant_id = new.tenant_id and a.brand_id = new.brand_id and a.active
        and a.network in (select private.social_place_network(c) from unnest(new.channels) c)
      order by a.network, a.created_at);
  end if;
  return new;
end;
$$;
revoke all on function private.social_post_accounts_fill() from public;
create trigger social_posts_accounts_fill
  before insert or update on public.social_posts
  for each row execute function private.social_post_accounts_fill();

-- A post's accounts are the workspace's own, of its brand, and of a network
-- one of its places is on. A post scheduled with accounts has an account
-- for every place it goes. (A workspace with no accounts at all schedules as
-- before, and the worker says Facebook needs connecting.)
create function private.social_post_accounts_check()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_place text;
begin
  if tg_op = 'UPDATE' and old.status in ('publishing', 'published') then
    return new;
  end if;
  if new.brand_id is not null and not exists (
    select 1 from public.brands b where b.id = new.brand_id and b.tenant_id = new.tenant_id
  ) then
    raise exception 'Brand not found' using errcode = 'P0002';
  end if;
  -- Checked when the accounts, brand or places change (an account later moved
  -- to another brand doesn't stop its earlier posts being tried again).
  if (tg_op = 'INSERT' or new.account_ids is distinct from old.account_ids
      or new.brand_id is distinct from old.brand_id or new.channels is distinct from old.channels)
     and exists (
    select 1 from unnest(new.account_ids) x
    where not exists (
      select 1 from public.social_accounts a
      where a.id = x and a.tenant_id = new.tenant_id and a.brand_id = new.brand_id
        and a.network in (select private.social_place_network(c) from unnest(new.channels) c))
  ) then
    raise exception 'account_not_for_post' using errcode = 'P0001';
  end if;
  if new.status = 'scheduled' and cardinality(new.account_ids) > 0
     and (tg_op = 'INSERT' or old.status <> 'publishing') then
    foreach v_place in array new.channels loop
      if not exists (
        select 1 from public.social_accounts a
        where a.id = any (new.account_ids) and a.network = private.social_place_network(v_place)
      ) then
        raise exception 'no_account_for_place' using errcode = 'P0001';
      end if;
    end loop;
  end if;
  return new;
end;
$$;
revoke all on function private.social_post_accounts_check() from public;
create trigger social_posts_accounts_guard
  before insert or update on public.social_posts
  for each row execute function private.social_post_accounts_check();

-- ---------------------------------------------------------------------------
-- Saving with a brand and accounts
-- ---------------------------------------------------------------------------

create function public.save_social_post_to(
  p_tenant_id uuid,
  p_post_id uuid,
  p_brand_id uuid,
  p_account_ids uuid[],
  p_channels text[],
  p_caption text,
  p_asset_ids uuid[],
  p_scheduled_for timestamptz,
  p_captions jsonb default '{}'::jsonb,
  p_project_id uuid default null,
  p_topic text default null,
  p_ai_draft text default null,
  p_planned_for timestamptz default null
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_brand uuid;
  -- In the order given, each once.
  v_accounts uuid[] := array(select u.x from unnest(coalesce(p_account_ids, '{}')) with ordinality as u(x, n)
                             group by u.x order by min(u.n));
  v_was public.social_posts;
  v_captions jsonb := '{}'::jsonb;
  v_key text;
  v_value text;
begin
  if not (p_tenant_id in (select private.user_tenant_ids())) then
    raise exception 'Workspace not found' using errcode = '42501';
  end if;
  if p_post_id is not null then
    select * into v_was from public.social_posts p
    where p.id = p_post_id and p.tenant_id = p_tenant_id;
  end if;
  v_brand := coalesce(p_brand_id, v_was.brand_id, private.ensure_default_brand(p_tenant_id));
  -- A brand that was put away keeps its old posts, but takes no new ones.
  if not exists (
    select 1 from public.brands b
    where b.id = v_brand and b.tenant_id = p_tenant_id
      and (b.archived_at is null or b.id = v_was.brand_id)
  ) then
    raise exception 'Brand not found' using errcode = 'P0002';
  end if;
  -- Only accounts in use, or ones the post already had.
  if exists (
    select 1 from unnest(v_accounts) x
    where not exists (
      select 1 from public.social_accounts a
      where a.id = x and a.tenant_id = p_tenant_id
        and (a.active or x = any (coalesce(v_was.account_ids, '{}'))))
  ) then
    raise exception 'account_not_for_post' using errcode = 'P0001';
  end if;

  perform set_config('mbs.social_post_to',
    jsonb_build_object('brand_id', v_brand, 'account_ids', to_jsonb(v_accounts))::text, true);
  v_id := public.save_social_post_full(
    p_tenant_id, p_post_id, p_caption, p_asset_ids, p_channels, p_scheduled_for,
    '{}'::jsonb, p_project_id, p_topic, p_ai_draft, p_planned_for);

  -- A caption of its own for an account the post goes to, only where the words differ.
  for v_key, v_value in select * from jsonb_each_text(coalesce(p_captions, '{}'::jsonb)) loop
    v_value := btrim(coalesce(v_value, ''));
    continue when v_value = '' or v_value = btrim(coalesce(p_caption, ''))
      or not (v_key = any (array(select x::text from unnest(v_accounts) x)));
    if char_length(v_value) > 2200 then
      raise exception 'caption_too_long' using errcode = 'P0001';
    end if;
    v_captions := v_captions || jsonb_build_object(v_key, v_value);
  end loop;
  update public.social_posts p set captions = v_captions where p.id = v_id;
  perform set_config('mbs.social_post_to', '', true);
  return v_id;
end;
$$;
revoke all on function public.save_social_post_to(uuid, uuid, uuid, uuid[], text[], text, uuid[], timestamptz, jsonb, uuid, text, text, timestamptz) from public, anon;
grant execute on function public.save_social_post_to(uuid, uuid, uuid, uuid[], text[], text, uuid[], timestamptz, jsonb, uuid, text, text, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- Answers, merged per account
-- ---------------------------------------------------------------------------

-- As before, with targets: `p_results` holds only the targets tried this time
-- and is merged in. The post is published once every target has an id;
-- otherwise it waits for another try, or fails after three. A bare place
-- name in `p_results` (a worker from before this change, finishing a post it
-- claimed) is read as that place's one account.
create or replace function public.finish_social_post(p_post_id uuid, p_results jsonb, p_retry boolean default true)
returns public.social_post_status
language plpgsql security definer set search_path = ''
as $$
declare
  v_post public.social_posts;
  v_targets text[];
  v_given jsonb := coalesce(p_results, '{}'::jsonb);
  v_results jsonb;
  v_missing text[];
  v_status public.social_post_status;
  v_key text;
  v_value jsonb;
  v_match text[];
begin
  select * into v_post from public.social_posts p where p.id = p_post_id for update;
  if not found or v_post.status <> 'publishing' then
    return v_post.status;
  end if;
  v_targets := private.social_post_targets(v_post.tenant_id, v_post.account_ids, v_post.channels);
  v_results := v_post.results;
  for v_key, v_value in select * from jsonb_each(v_given) loop
    if v_key = any (v_targets) then
      v_results := v_results || jsonb_build_object(v_key, v_value);
    elsif cardinality(v_post.account_ids) > 0 and v_key = any (v_post.channels) then
      v_match := array(select t from unnest(v_targets) t where t like '%:' || v_key);
      if cardinality(v_match) = 1 then
        v_results := v_results || jsonb_build_object(v_match[1], v_value, v_key, v_value);
      end if;
    elsif cardinality(v_post.account_ids) = 0 then
      v_results := v_results || jsonb_build_object(v_key, v_value);
    end if;
  end loop;
  select coalesce(array_agg(t order by n), '{}') into v_missing
  from unnest(v_targets) with ordinality as x(t, n)
  where v_results -> t ->> 'id' is null;

  v_status := case
    when cardinality(v_targets) > 0 and cardinality(v_missing) = 0 then 'published'
    when cardinality(v_targets) = 0 then 'failed'
    when p_retry and v_post.attempts < 3 then 'scheduled'
    else 'failed'
  end;
  update public.social_posts p
  set status = v_status, results = v_results,
      published_at = case when v_status = 'published' then now() else null end,
      error = case when v_status = 'published' then null
                   when cardinality(v_targets) = 0 then 'Nothing to send it to'
                   else (select string_agg(t || ': ' || coalesce(v_results -> t ->> 'error', 'not sent'), '; ')
                         from unnest(v_missing) as t) end
  where p.id = p_post_id;
  return v_status;
end;
$$;

-- Tries a post that didn't go out again, now. What went out stays out and is
-- never sent again; only the accounts that failed are tried. Anyone on the
-- team can press it for a post that was approved; where approval is required
-- and nobody who may approve said yes to it (a post from before review was
-- switched on), only an approver's press sends it, and their name goes on it.
create function public.retry_social_post(p_tenant_id uuid, p_post_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_member(p_tenant_id);
  update public.social_posts p
  set status = 'scheduled',
      scheduled_for = greatest(coalesce(p.scheduled_for, now()), now()),
      attempts = 0, locked_at = null, error = null,
      approved_by = case
        when p.approved_by is not null and private.can_approve_social(p.tenant_id, p.approved_by)
          then p.approved_by
        when private.can_approve_social(p.tenant_id, auth.uid()) then auth.uid()
        else p.approved_by end,
      approved_at = case
        when p.approved_by is not null and private.can_approve_social(p.tenant_id, p.approved_by)
          then p.approved_at
        when private.can_approve_social(p.tenant_id, auth.uid()) then now()
        else p.approved_at end,
      -- Keep each answer that went out; forget the failures.
      results = coalesce((select jsonb_object_agg(r.key, r.value) from jsonb_each(p.results) r
                          where r.value ->> 'id' is not null), '{}'::jsonb)
  where p.id = p_post_id and p.tenant_id = p_tenant_id and p.status = 'failed';
  if not found then
    raise exception 'locked' using errcode = 'P0001';
  end if;
end;
$$;
revoke all on function public.retry_social_post(uuid, uuid) from public, anon;
grant execute on function public.retry_social_post(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Existing posts, in place. Every post gets its workspace's main brand. A
-- post that goes to Facebook or Instagram gets the account(s) of the
-- workspace's one connection for those places, and each place's answer is
-- copied to that account's target. The answers under the bare place names
-- are KEPT beside them, so a worker still running the earlier code during
-- the deploy sees what went out and never sends it again. The same for
-- captions: a place's own caption also becomes that account's. Triggers are
-- held while this runs: these posts were valid when saved, and moving them
-- changes nothing about what they are.
-- ---------------------------------------------------------------------------

alter table public.social_posts disable trigger user;

update public.social_posts p
set brand_id = private.ensure_default_brand(p.tenant_id)
where p.brand_id is null;

with links as (
  select p.id as post_id,
         array_agg(a.id order by case a.network when 'facebook' then 0 else 1 end) as accounts
  from public.social_posts p
  join public.connections c on c.tenant_id = p.tenant_id and c.provider = 'meta'
  join public.social_accounts a
    on a.tenant_id = p.tenant_id and a.connection_id = c.id and a.page_id = c.external_account_id
   and a.network in (select private.social_place_network(x) from unnest(p.channels) x)
  where cardinality(p.account_ids) = 0
  group by p.id
)
update public.social_posts p
set account_ids = l.accounts
from links l
where p.id = l.post_id;

update public.social_posts p
set results = p.results || coalesce((
      select jsonb_object_agg(t, p.results -> split_part(t, ':', 2))
      from unnest(private.social_post_targets(p.tenant_id, p.account_ids, p.channels)) t
      where p.results ? split_part(t, ':', 2) and not p.results ? t), '{}'::jsonb),
    captions = coalesce(p.captions, '{}'::jsonb) || coalesce((
      select jsonb_object_agg(a.id::text, p.captions -> case a.network when 'facebook' then 'facebook' else 'instagram' end)
      from public.social_accounts a
      where a.id = any (p.account_ids)
        and p.captions ? (case a.network when 'facebook' then 'facebook' else 'instagram' end)), '{}'::jsonb)
where cardinality(p.account_ids) > 0;

alter table public.social_posts enable trigger user;
