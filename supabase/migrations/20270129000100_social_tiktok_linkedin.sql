-- Social: TikTok and LinkedIn, posted to directly through each platform's
-- own API, beside Facebook and Instagram.
--
-- Connections. Each is one connection per workspace, like every other
-- provider (`connections` stays one row per provider), holding SEVERAL
-- logins: one TikTok account per login, and one LinkedIn person per login
-- with the company pages they look after. Each login's tokens sit in the
-- connection's one Vault secret under "login:<id>" (the server's
-- `lib/connections/logins.ts`), read only through `getProviderToken` and
-- refreshed under the connection's refresh lock. Nothing secret is here.
--
-- Accounts. A TikTok account, a LinkedIn person and a LinkedIn company page
-- are `social_accounts` rows of network 'tiktok' / 'linkedin', with
-- `login_id` saying which login posts as them. What a login offered is
-- written by the server (`note_login_accounts`); which are used, and as
-- which brand, is still `choose_social_accounts`. An owner or admin can let
-- go of one login (`forget_social_login`) without touching the others.
--
-- Places. 'tiktok' and 'linkedin' are two more places; every network's own
-- rules (caption length, hashtags, how many photos, video or not) are ONE
-- table, `private.social_place_rule`, kept in step with PLACE_RULES in
-- src/lib/social/networks.ts by a test, and checked whenever a post becomes
-- scheduled. TikTok's per-post choices (who can see it, comments, duets,
-- stitches, brand marks) are `social_posts.target_options`, per account.
--
-- Sending once. TikTok and LinkedIn can take a while, and can leave us not
-- knowing. A target's answer in `results` can now also be:
--   {"sending": at}           the worker is about to make the one write that
--                             posts it (`begin_social_target`);
--   {"pending": ref, "since"} the network has it and is still preparing it:
--                             the worker asks again, it never sends again;
--   {"unsure": words}         we never heard back: nothing sends it again by
--                             itself; a person looks and says whether it went
--                             (`settle_social_target`).
-- None of these can be wiped by a save, a retry or a delete while they
-- stand (`social_posts_keep_in_flight`).
--
-- During the deploy. The earlier worker calls `claim_due_social_posts`,
-- which now hands out only posts whose places are all Facebook and
-- Instagram, so it never sees a TikTok or LinkedIn target. The new worker
-- calls `claim_due_social_posts_for` with the places it can send. The
-- earlier worker's `finish_social_post` calls get the same answers as
-- before for the posts it can claim. Existing rows need nothing: the new
-- columns default to empty.

-- ---------------------------------------------------------------------------
-- Providers, networks, places
-- ---------------------------------------------------------------------------

alter table public.connections drop constraint connections_provider_check;
alter table public.connections add constraint connections_provider_check
  check (provider in ('shopify', 'quickbooks', 'meta', 'google', 'stripe', 'easypost', 'ups',
                      'redo', 'google_mail', 'michaels', 'twilio', 'eventbrite',
                      'tiktok', 'linkedin'));

alter table public.social_accounts drop constraint social_accounts_network_check;
alter table public.social_accounts add constraint social_accounts_network_check
  check (network in ('facebook', 'instagram', 'tiktok', 'linkedin'));

alter table public.social_accounts
  -- Which of the connection's logins posts as this account ('tiktok' and
  -- 'linkedin'; a Meta account goes through its Page instead).
  add column login_id text check (login_id is null or char_length(login_id) between 1 and 200),
  -- Its login has to be connected again before it can post (a token ran out).
  add column needs_login boolean not null default false,
  -- What the network says this account may choose for a post (TikTok's
  -- creator info: who can see it, whether comments are off). Never secret.
  add column posting_options jsonb not null default '{}'::jsonb
    check (jsonb_typeof(posting_options) = 'object'),
  add column posting_options_at timestamptz;
create index social_accounts_login_idx on public.social_accounts (tenant_id, network, login_id)
  where login_id is not null;

alter table public.social_posts
  drop constraint social_posts_channels_check,
  add constraint social_posts_channels_check
    check (channels <@ array['facebook', 'instagram', 'instagram_story', 'tiktok', 'linkedin']::text[]),
  -- {"<account id>": {...}}: a network's own choices for one account's post
  -- (TikTok: privacy_level, allow_comment, allow_duet, allow_stitch,
  -- brand_organic, brand_content). Written only through
  -- `save_social_post_with_options`, checked by `private.tidy_target_options`.
  add column target_options jsonb not null default '{}'::jsonb
    check (jsonb_typeof(target_options) = 'object');

create or replace function private.social_place_network(p_place text)
returns text
language sql immutable set search_path = ''
as $$
  select case p_place when 'facebook' then 'facebook'
                      when 'instagram' then 'instagram'
                      when 'instagram_story' then 'instagram'
                      when 'tiktok' then 'tiktok'
                      when 'linkedin' then 'linkedin' end;
$$;

-- ---------------------------------------------------------------------------
-- Every place's rules: the same table as PLACE_RULES in
-- src/lib/social/networks.ts (tests/db/social-networks.test.ts compares them).
-- ---------------------------------------------------------------------------

create function private.social_place_rule(p_place text)
returns table (
  network text, caption_max int, hashtags_max int, photos_max int,
  video_ok boolean, needs_media boolean, needs_video boolean
)
language sql immutable set search_path = ''
as $$
  select r.network, r.caption_max, r.hashtags_max, r.photos_max, r.video_ok, r.needs_media, r.needs_video
  from (values
    ('facebook',        'facebook',  2200, null::int, 10, true, false, false),
    ('instagram',       'instagram', 2200, 30,        10, true, true,  false),
    ('instagram_story', 'instagram', null, null,      1,  true, true,  false),
    ('tiktok',          'tiktok',    2200, null,      0,  true, true,  true),
    ('linkedin',        'linkedin',  3000, null,      10, true, false, false)
  ) as r(place, network, caption_max, hashtags_max, photos_max, video_ok, needs_media, needs_video)
  where r.place = p_place;
$$;
revoke all on function private.social_place_rule(text) from public;

-- Checks a scheduled post against the rules of every place it goes, for
-- each account's own words. Raises 'place_rule:<what>:<place>' (or a TikTok
-- choice's own code), which the app turns into plain words.
create function private.social_post_rules_check(p_post public.social_posts)
returns void
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_place text;
  v_rule record;
  v_ids uuid[];
  v_video boolean;
  v_photos int;
  v_words text;
  v_account public.social_accounts;
  v_opts jsonb;
  v_privacy text;
  v_allowed jsonb;
begin
  v_ids := case when cardinality(p_post.asset_ids) > 0 then p_post.asset_ids
                when p_post.asset_id is not null then array[p_post.asset_id]
                else '{}'::uuid[] end;
  select coalesce(bool_or(a.mime_type like 'video/%'), false),
         count(*) filter (where a.mime_type like 'image/%')
    into v_video, v_photos
  from public.social_assets a
  where a.id = any (v_ids) and a.tenant_id = p_post.tenant_id;

  foreach v_place in array p_post.channels loop
    select * into v_rule from private.social_place_rule(v_place);
    if not found then
      raise exception 'place_rule:unknown:%', v_place using errcode = 'P0001';
    end if;
    if v_rule.needs_video and not v_video then
      raise exception 'place_rule:needs_video:%', v_place using errcode = 'P0001';
    elsif v_rule.needs_media and not v_video and v_photos = 0 then
      raise exception 'place_rule:needs_media:%', v_place using errcode = 'P0001';
    end if;
    if v_video and not v_rule.video_ok then
      raise exception 'place_rule:no_video:%', v_place using errcode = 'P0001';
    end if;
    if not v_video and v_photos > v_rule.photos_max then
      raise exception 'place_rule:too_many_photos:%', v_place using errcode = 'P0001';
    end if;
    -- The newer networks have no route by place alone: they need an account.
    if v_rule.network not in ('facebook', 'instagram') and not exists (
      select 1 from public.social_accounts a
      where a.id = any (p_post.account_ids) and a.network = v_rule.network
    ) then
      raise exception 'place_rule:no_account:%', v_place using errcode = 'P0001';
    end if;
    if v_rule.caption_max is not null then
      for v_words in
        select coalesce(nullif(btrim(p_post.captions ->> a.id::text), ''),
                        nullif(btrim(p_post.captions ->> v_place), ''),
                        p_post.caption)
        from public.social_accounts a
        where a.id = any (p_post.account_ids) and a.network = v_rule.network
        union all
        select coalesce(nullif(btrim(p_post.captions ->> v_place), ''), p_post.caption)
        where cardinality(p_post.account_ids) = 0
      loop
        if char_length(coalesce(v_words, '')) > v_rule.caption_max then
          raise exception 'place_rule:caption_long:%', v_place using errcode = 'P0001';
        end if;
        if v_rule.hashtags_max is not null and (
          select count(*) from regexp_matches(coalesce(v_words, ''), '(^|\s)#[[:alnum:]_]+', 'g')
        ) > v_rule.hashtags_max then
          raise exception 'place_rule:hashtags:%', v_place using errcode = 'P0001';
        end if;
      end loop;
    end if;
    -- TikTok's own choices: who can see it, among what TikTok last said this
    -- account may choose; branded content is never private.
    if v_place = 'tiktok' then
      for v_account in
        select * from public.social_accounts a
        where a.id = any (p_post.account_ids) and a.network = 'tiktok'
      loop
        v_opts := coalesce(p_post.target_options -> v_account.id::text, '{}'::jsonb);
        v_privacy := v_opts ->> 'privacy_level';
        if v_privacy is null then
          raise exception 'tiktok_needs_privacy' using errcode = 'P0001';
        end if;
        v_allowed := v_account.posting_options -> 'privacy_level_options';
        if jsonb_typeof(v_allowed) = 'array' and jsonb_array_length(v_allowed) > 0
           and not (v_allowed ? v_privacy) then
          raise exception 'tiktok_privacy_not_allowed' using errcode = 'P0001';
        end if;
        if coalesce((v_opts ->> 'brand_content')::boolean, false) and v_privacy = 'SELF_ONLY' then
          raise exception 'tiktok_branded_private' using errcode = 'P0001';
        end if;
      end loop;
    end if;
  end loop;
end;
$$;
revoke all on function private.social_post_rules_check(public.social_posts) from public;

-- Whenever a post becomes (or stays) scheduled, except a worker's retry. A
-- save through `save_social_post_to` writes the post in steps (the row, then
-- its photos, then each account's words), so it checks the finished post
-- once at its end instead. Named to run after the older checks, whose
-- refusals stay the ones people see first.
create function private.social_post_rules_trigger()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.status <> 'scheduled' or (tg_op = 'UPDATE' and old.status = 'publishing') then
    return new;
  end if;
  if nullif(current_setting('mbs.social_post_to', true), '') is not null then
    return new;
  end if;
  perform private.social_post_rules_check(new);
  return new;
end;
$$;
revoke all on function private.social_post_rules_trigger() from public;
create trigger social_posts_zz_place_rules
  before insert or update on public.social_posts
  for each row execute function private.social_post_rules_trigger();

-- ---------------------------------------------------------------------------
-- TikTok's choices on a post
-- ---------------------------------------------------------------------------

-- `p_options` is {"<account id>": {privacy_level, allow_comment, allow_duet,
-- allow_stitch, brand_organic, brand_content}}. Only the post's own TikTok
-- accounts; only known values; anything else is refused or dropped.
create function private.tidy_target_options(p_tenant_id uuid, p_account_ids uuid[], p_options jsonb)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_key text;
  v_value jsonb;
  v_out jsonb := '{}'::jsonb;
  v_privacy text;
  v_flag text;
  v_one jsonb;
begin
  if p_options is null or p_options = 'null'::jsonb then
    return '{}'::jsonb;
  end if;
  if jsonb_typeof(p_options) <> 'object' then
    raise exception 'options_not_valid' using errcode = '22023';
  end if;
  for v_key, v_value in select * from jsonb_each(p_options) loop
    continue when not exists (
      select 1 from public.social_accounts a
      where a.id::text = v_key and a.tenant_id = p_tenant_id and a.network = 'tiktok'
        and a.id = any (coalesce(p_account_ids, '{}')));
    if jsonb_typeof(v_value) <> 'object' then
      raise exception 'options_not_valid' using errcode = '22023';
    end if;
    v_privacy := v_value ->> 'privacy_level';
    if v_privacy is not null and v_privacy not in
       ('PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY') then
      raise exception 'options_not_valid' using errcode = '22023';
    end if;
    v_one := jsonb_build_object('privacy_level', v_privacy);
    foreach v_flag in array array['allow_comment', 'allow_duet', 'allow_stitch', 'brand_organic', 'brand_content'] loop
      if v_value ? v_flag and jsonb_typeof(v_value -> v_flag) <> 'boolean' then
        raise exception 'options_not_valid' using errcode = '22023';
      end if;
      v_one := v_one || jsonb_build_object(v_flag, coalesce((v_value ->> v_flag)::boolean, false));
    end loop;
    v_out := v_out || jsonb_build_object(v_key, v_one);
  end loop;
  return v_out;
end;
$$;
revoke all on function private.tidy_target_options(uuid, uuid[], jsonb) from public;

-- Inside `save_social_post_with_options` the choices it was handed are put
-- on the post as it is written; nothing else writes them. A post going out,
-- or out, is never touched.
create function private.social_post_options_fill()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_given text := nullif(current_setting('mbs.social_post_options', true), '');
begin
  if v_given is null or (tg_op = 'UPDATE' and old.status in ('publishing', 'published')) then
    return new;
  end if;
  new.target_options := v_given::jsonb;
  return new;
end;
$$;
revoke all on function private.social_post_options_fill() from public;
create trigger social_posts_options_fill
  before insert or update on public.social_posts
  for each row execute function private.social_post_options_fill();

-- ---------------------------------------------------------------------------
-- Saving: as before, then the finished post is checked against every
-- place's rules once (the body is the earlier migration's, plus that check).
-- ---------------------------------------------------------------------------

create or replace function public.save_social_post_to(
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
  v_accounts uuid[] := array(select u.x from unnest(coalesce(p_account_ids, '{}')) with ordinality as u(x, n)
                             group by u.x order by min(u.n));
  v_was public.social_posts;
  v_captions jsonb := '{}'::jsonb;
  v_key text;
  v_value text;
  v_post public.social_posts;
begin
  if not (p_tenant_id in (select private.user_tenant_ids())) then
    raise exception 'Workspace not found' using errcode = '42501';
  end if;
  if p_post_id is not null then
    select * into v_was from public.social_posts p
    where p.id = p_post_id and p.tenant_id = p_tenant_id;
  end if;
  v_brand := coalesce(p_brand_id, v_was.brand_id, private.ensure_default_brand(p_tenant_id));
  if not exists (
    select 1 from public.brands b
    where b.id = v_brand and b.tenant_id = p_tenant_id
      and (b.archived_at is null or b.id = v_was.brand_id)
  ) then
    raise exception 'Brand not found' using errcode = 'P0002';
  end if;
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

  select * into v_post from public.social_posts p where p.id = v_id;
  if v_post.status = 'scheduled' then
    perform private.social_post_rules_check(v_post);
  end if;
  return v_id;
end;
$$;

-- The composer's save: everything `save_social_post_to` takes, plus each
-- TikTok account's choices, written in the same go.
create function public.save_social_post_with_options(
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
  p_planned_for timestamptz default null,
  p_target_options jsonb default '{}'::jsonb
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not (p_tenant_id in (select private.user_tenant_ids())) then
    raise exception 'Workspace not found' using errcode = '42501';
  end if;
  perform set_config('mbs.social_post_options',
    private.tidy_target_options(p_tenant_id, p_account_ids, p_target_options)::text, true);
  v_id := public.save_social_post_to(
    p_tenant_id, p_post_id, p_brand_id, p_account_ids, p_channels, p_caption, p_asset_ids,
    p_scheduled_for, p_captions, p_project_id, p_topic, p_ai_draft, p_planned_for);
  perform set_config('mbs.social_post_options', '', true);
  return v_id;
end;
$$;
revoke all on function public.save_social_post_with_options(uuid, uuid, uuid, uuid[], text[], text, uuid[], timestamptz, jsonb, uuid, text, text, timestamptz, jsonb) from public, anon;
grant execute on function public.save_social_post_with_options(uuid, uuid, uuid, uuid[], text[], text, uuid[], timestamptz, jsonb, uuid, text, text, timestamptz, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- What is on its way, or unknown, stays put
-- ---------------------------------------------------------------------------

create function private.social_result_in_flight(p_value jsonb)
returns boolean
language sql immutable set search_path = ''
as $$
  select jsonb_typeof(p_value) = 'object'
     and p_value ->> 'id' is null
     and (p_value ? 'pending' or p_value ? 'unsure' or p_value ? 'sending');
$$;
revoke all on function private.social_result_in_flight(jsonb) from public;

-- Only the publishing functions below change an answer that is on its way
-- or unknown (they say so with `mbs.social_results`); a save, an approval or
-- a retry that would wipe one is refused, and so is deleting a post the
-- network is still preparing.
create function private.social_post_keep_in_flight()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if coalesce(current_setting('mbs.social_results', true), '') = 'on' then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    if exists (
      select 1 from jsonb_each(old.results) r
      where private.social_result_in_flight(r.value) and not (r.value ? 'unsure')
    ) then
      raise exception 'in_flight' using errcode = 'P0001';
    end if;
    return old;
  end if;
  if exists (
    select 1 from jsonb_each(old.results) r
    where private.social_result_in_flight(r.value)
      and new.results -> r.key is distinct from r.value
  ) then
    raise exception 'in_flight' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function private.social_post_keep_in_flight() from public;
create trigger social_posts_keep_in_flight
  before update or delete on public.social_posts
  for each row execute function private.social_post_keep_in_flight();

-- ---------------------------------------------------------------------------
-- The worker: claiming, the one write, answers
-- ---------------------------------------------------------------------------

-- Hands out due posts whose places are all ones the calling worker can send.
create function public.claim_due_social_posts_for(p_limit int, p_places text[])
returns setof public.social_posts
language sql security definer set search_path = ''
as $$
  update public.social_posts p
  set status = 'publishing', locked_at = now(), attempts = p.attempts + 1
  where p.id in (
    select d.id from public.social_posts d
    where d.status in ('scheduled', 'publishing')
      and d.scheduled_for <= now()
      and (d.locked_at is null or d.locked_at < now() - interval '10 minutes')
      and d.channels <@ coalesce(p_places, '{}')
    order by d.scheduled_for
    limit greatest(1, least(coalesce(p_limit, 10), 50))
    for update skip locked
  )
  returning p.*;
$$;

-- The earlier worker's call: Facebook and Instagram only, as it always sent.
create or replace function public.claim_due_social_posts(p_limit int default 10)
returns setof public.social_posts
language sql security definer set search_path = ''
as $$
  select * from public.claim_due_social_posts_for(
    p_limit, array['facebook', 'instagram', 'instagram_story']);
$$;

-- Marks one target as about to be sent, just before the one write that
-- posts it. True only when it is the post's target, the post is out with
-- the worker, and nothing went, is on its way or is unknown for it already.
-- A worker that stops after this leaves the mark, and the next one says
-- "unsure" instead of sending again.
create function public.begin_social_target(p_post_id uuid, p_target text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_post public.social_posts;
  v_value jsonb;
begin
  select * into v_post from public.social_posts p where p.id = p_post_id for update;
  if not found or v_post.status <> 'publishing'
     or not (p_target = any (private.social_post_targets(v_post.tenant_id, v_post.account_ids, v_post.channels))) then
    return false;
  end if;
  v_value := v_post.results -> p_target;
  if v_value is not null and (
       v_value ->> 'id' is not null or v_value ? 'unsure' or v_value ? 'sending'
       or coalesce((v_value ->> 'stop')::boolean, false)) then
    return false;
  end if;
  perform set_config('mbs.social_results', 'on', true);
  update public.social_posts p
  set results = p.results || jsonb_build_object(p_target, jsonb_build_object('sending', now()))
  where p.id = p_post_id;
  perform set_config('mbs.social_results', '', true);
  return true;
end;
$$;

-- As before, merging each target's answer, and now also: a target still
-- being prepared keeps the post coming back to be asked about (without
-- using up its tries), one we never heard back about is never tried again
-- by itself, and a failure that won't be tried again by itself is marked
-- `stop` so nothing sends it until a person presses "Try again".
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
  v_pending text[];
  v_open text[];
  v_status public.social_post_status;
  v_retrying boolean;
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
    -- What went out stays as it went.
    continue when v_results -> v_key ->> 'id' is not null;
    if v_key = any (v_targets) then
      v_results := v_results || jsonb_build_object(v_key, v_value);
    elsif cardinality(v_post.account_ids) > 0 and v_key = any (v_post.channels) then
      v_match := array(select t from unnest(v_targets) t where t like '%:' || v_key);
      if cardinality(v_match) = 1 and v_results -> v_match[1] ->> 'id' is null then
        v_results := v_results || jsonb_build_object(v_match[1], v_value, v_key, v_value);
      end if;
    elsif cardinality(v_post.account_ids) = 0 then
      v_results := v_results || jsonb_build_object(v_key, v_value);
    end if;
  end loop;

  select coalesce(array_agg(t order by n), '{}') into v_missing
  from unnest(v_targets) with ordinality as x(t, n)
  where v_results -> t ->> 'id' is null;
  select coalesce(array_agg(t), '{}') into v_pending
  from unnest(v_missing) t where v_results -> t ? 'pending';
  select coalesce(array_agg(t), '{}') into v_open
  from unnest(v_missing) t
  where not coalesce(v_results -> t ? 'pending' or v_results -> t ? 'unsure' or v_results -> t ? 'sending', false)
    and not coalesce((v_results -> t ->> 'stop')::boolean, false);

  v_retrying := cardinality(v_open) > 0 and p_retry and v_post.attempts < 3;
  v_status := case
    when cardinality(v_targets) > 0 and cardinality(v_missing) = 0 then 'published'
    when cardinality(v_targets) = 0 then 'failed'
    when v_retrying then 'scheduled'
    when cardinality(v_pending) > 0 then 'scheduled'
    else 'failed'
  end;
  if not v_retrying and cardinality(v_open) > 0 then
    v_results := v_results || (
      select jsonb_object_agg(t, coalesce(v_results -> t, '{"error": "not sent"}'::jsonb) || '{"stop": true}'::jsonb)
      from unnest(v_open) t);
  end if;

  perform set_config('mbs.social_results', 'on', true);
  update public.social_posts p
  set status = v_status, results = v_results,
      -- Coming back only to ask about what is being prepared uses no try.
      attempts = case when v_status = 'scheduled' and not v_retrying
                      then greatest(p.attempts - 1, 0) else p.attempts end,
      published_at = case when v_status = 'published' then now() else null end,
      error = case when v_status = 'published' then null
                   when cardinality(v_targets) = 0 then 'Nothing to send it to'
                   else (select string_agg(t || ': ' || coalesce(
                                  v_results -> t ->> 'error',
                                  v_results -> t ->> 'unsure',
                                  case when v_results -> t ? 'sending' then 'we lost track of it while it was being sent' end,
                                  case when v_results -> t ? 'pending' then 'still being prepared' end,
                                  'not sent'), '; ')
                         from unnest(v_missing) as t) end
  where p.id = p_post_id;
  perform set_config('mbs.social_results', '', true);
  return v_status;
end;
$$;

-- Tries a post that didn't go out again, now: as before, keeping what went
-- out. A target we never heard back about must be settled by a person first
-- (`settle_social_target`), so a press here can never post it twice.
create or replace function public.retry_social_post(p_tenant_id uuid, p_post_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_member(p_tenant_id);
  if exists (
    select 1 from public.social_posts p, jsonb_each(p.results) r
    where p.id = p_post_id and p.tenant_id = p_tenant_id and private.social_result_in_flight(r.value)
  ) then
    raise exception 'settle_unsure' using errcode = 'P0001';
  end if;
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
      results = coalesce((select jsonb_object_agg(r.key, r.value) from jsonb_each(p.results) r
                          where r.value ->> 'id' is not null), '{}'::jsonb)
  where p.id = p_post_id and p.tenant_id = p_tenant_id and p.status = 'failed';
  if not found then
    raise exception 'locked' using errcode = 'P0001';
  end if;
end;
$$;

-- A person looked on the network and says whether a post we never heard
-- back about went out. If it went, it counts as posted and is never sent
-- again; if it didn't, it can be tried again with "Try again".
create function public.settle_social_target(
  p_tenant_id uuid, p_post_id uuid, p_target text, p_went boolean
)
returns public.social_post_status
language plpgsql security definer set search_path = ''
as $$
declare
  v_post public.social_posts;
  v_results jsonb;
  v_targets text[];
  v_status public.social_post_status;
begin
  perform private.require_member(p_tenant_id);
  select * into v_post from public.social_posts p
  where p.id = p_post_id and p.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'Post not found' using errcode = 'P0002';
  end if;
  if v_post.status <> 'failed' or not coalesce(
       private.social_result_in_flight(v_post.results -> p_target)
       and not (v_post.results -> p_target ? 'pending'), false) then
    raise exception 'nothing_to_settle' using errcode = 'P0001';
  end if;
  v_results := case when p_went
    then v_post.results || jsonb_build_object(p_target, jsonb_build_object(
           'id', 'checked-by-hand', 'checked_by', auth.uid(), 'checked_at', now()))
    else v_post.results - p_target end;
  v_targets := private.social_post_targets(v_post.tenant_id, v_post.account_ids, v_post.channels);
  v_status := case when cardinality(v_targets) > 0 and not exists (
                     select 1 from unnest(v_targets) t where v_results -> t ->> 'id' is null)
                   then 'published' else 'failed' end;
  perform set_config('mbs.social_results', 'on', true);
  update public.social_posts p
  set results = v_results, status = v_status,
      published_at = case when v_status = 'published' then now() else p.published_at end,
      error = case when v_status = 'published' then null else p.error end
  where p.id = p_post_id;
  perform set_config('mbs.social_results', '', true);
  perform private.log_audit(p_tenant_id,
    case when p_went then 'social.target_confirmed' else 'social.target_not_there' end,
    'social_post', p_post_id::text, jsonb_build_object('target', p_target));
  return v_status;
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.claim_due_social_posts_for(int, text[])',
    'public.begin_social_target(uuid, text)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
  execute 'revoke all on function public.settle_social_target(uuid, uuid, text, boolean) from public, anon';
  execute 'grant execute on function public.settle_social_target(uuid, uuid, text, boolean) to authenticated';
end;
$$;

-- ---------------------------------------------------------------------------
-- Logins and their accounts (TikTok, LinkedIn)
-- ---------------------------------------------------------------------------

create function private.login_provider_networks(p_provider text)
returns text[]
language sql immutable set search_path = ''
as $$
  select case p_provider when 'tiktok' then array['tiktok'] when 'linkedin' then array['linkedin'] end;
$$;
revoke all on function private.login_provider_networks(text) from public;

-- What one login offered: `p_accounts` is [{network, platform_id, name,
-- handle, tasks}]. Known accounts are refreshed and keep the workspace's
-- choices (and come back into use if a disconnect put them aside); new ones
-- arrive unused; ones this login no longer offers can't be used any more. A
-- workspace using no account of a network starts using the first one this
-- login offered, on its main brand, as a Facebook login always did.
create function public.note_login_accounts(
  p_tenant_id uuid, p_provider text, p_login_id text, p_accounts jsonb
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_connection uuid;
  v_brand uuid;
  v_networks text[] := private.login_provider_networks(p_provider);
  v_item jsonb;
  v_offered text[] := '{}';
  v_network text;
  v_first uuid;
  v_started int := 0;
begin
  if v_networks is null or coalesce(p_login_id, '') = '' or char_length(p_login_id) > 200 then
    raise exception 'That login is not valid' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_accounts, 'null'::jsonb)) <> 'array' then
    raise exception 'That list is not valid' using errcode = '22023';
  end if;
  select c.id into v_connection from public.connections c
  where c.tenant_id = p_tenant_id and c.provider = p_provider and c.status <> 'disconnected';
  if v_connection is null then
    raise exception 'Not connected' using errcode = 'P0002';
  end if;
  perform 1 from public.tenants t where t.id = p_tenant_id for update;
  v_brand := private.ensure_default_brand(p_tenant_id);

  for v_item in select * from jsonb_array_elements(p_accounts) loop
    continue when not ((v_item ->> 'network') = any (v_networks))
      or coalesce(v_item ->> 'platform_id', '') = '' or char_length(v_item ->> 'platform_id') > 200;
    v_offered := v_offered || (v_item ->> 'network' || ':' || (v_item ->> 'platform_id'));
    insert into public.social_accounts
      (tenant_id, connection_id, brand_id, network, platform_id, login_id, name, handle, tasks, offered)
    values (
      p_tenant_id, v_connection, v_brand, v_item ->> 'network', v_item ->> 'platform_id', p_login_id,
      left(nullif(btrim(coalesce(v_item ->> 'name', '')), ''), 200),
      case when v_item ->> 'handle' ~ '^[A-Za-z0-9._]{1,30}$' then v_item ->> 'handle' end,
      case when jsonb_typeof(v_item -> 'tasks') = 'array'
           then array(select upper(t) from jsonb_array_elements_text(v_item -> 'tasks') t
                      where t ~ '^[A-Za-z_]{1,40}$') end,
      true)
    on conflict (tenant_id, network, platform_id) do update
      set connection_id = excluded.connection_id, login_id = excluded.login_id,
          name = coalesce(excluded.name, public.social_accounts.name),
          handle = coalesce(excluded.handle, public.social_accounts.handle),
          tasks = excluded.tasks, offered = true, needs_login = false;
  end loop;

  -- No longer offered by this login: out of use, kept.
  update public.social_accounts a
  set offered = false, active = false
  where a.tenant_id = p_tenant_id and a.login_id = p_login_id and a.network = any (v_networks)
    and not ((a.network || ':' || a.platform_id) = any (v_offered));

  -- Back from a disconnect: what was in use is in use again.
  update public.social_accounts a set active = true, paused = false
  where a.tenant_id = p_tenant_id and a.login_id = p_login_id and a.paused and a.offered
    and not exists (select 1 from public.social_accounts o
                    where o.network = a.network and o.platform_id = a.platform_id and o.active);
  update public.social_accounts a set paused = false
  where a.tenant_id = p_tenant_id and a.login_id = p_login_id and a.paused;

  foreach v_network in array v_networks loop
    if not exists (select 1 from public.social_accounts a
                   where a.tenant_id = p_tenant_id and a.network = v_network and a.active) then
      select a.id into v_first from public.social_accounts a
      where a.tenant_id = p_tenant_id and a.login_id = p_login_id and a.network = v_network
        and a.offered
        and not exists (select 1 from public.social_accounts o
                        where o.network = a.network and o.platform_id = a.platform_id and o.active)
      order by array_position(v_offered, a.network || ':' || a.platform_id)
      limit 1;
      if v_first is not null then
        update public.social_accounts a
        set active = true, brand_id = v_brand, chosen_at = now()
        where a.id = v_first;
        v_started := v_started + 1;
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'offered', cardinality(v_offered),
    'started', v_started,
    'waiting', (select count(*) from public.social_accounts a
                where a.tenant_id = p_tenant_id and a.login_id = p_login_id and a.offered
                  and not a.active and a.chosen_at is null));
end;
$$;

-- A login's token ran out (or came back): its accounts say so, and the
-- composer and worker stop trying them until it is connected again.
create function public.mark_social_login(
  p_tenant_id uuid, p_provider text, p_login_id text, p_needs boolean
)
returns void
language sql security definer set search_path = ''
as $$
  update public.social_accounts a set needs_login = coalesce(p_needs, false)
  where a.tenant_id = p_tenant_id and a.login_id = p_login_id
    and a.network = any (private.login_provider_networks(p_provider));
$$;

-- What the network said this account may choose for a post (TikTok's creator
-- info), as the server read it. Only the known keys are kept.
create function public.note_social_account_options(
  p_tenant_id uuid, p_account_id uuid, p_options jsonb
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_levels jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(coalesce(p_options, 'null'::jsonb)) <> 'object' then
    raise exception 'options_not_valid' using errcode = '22023';
  end if;
  if jsonb_typeof(p_options -> 'privacy_level_options') = 'array' then
    select coalesce(jsonb_agg(l), '[]'::jsonb) into v_levels
    from jsonb_array_elements_text(p_options -> 'privacy_level_options') l
    where l in ('PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY');
  end if;
  update public.social_accounts a
  set posting_options = jsonb_build_object(
        'privacy_level_options', v_levels,
        'comment_disabled', coalesce((p_options ->> 'comment_disabled')::boolean, false),
        'duet_disabled', coalesce((p_options ->> 'duet_disabled')::boolean, false),
        'stitch_disabled', coalesce((p_options ->> 'stitch_disabled')::boolean, false),
        'max_video_post_duration_sec',
          case when jsonb_typeof(p_options -> 'max_video_post_duration_sec') = 'number'
               then (p_options ->> 'max_video_post_duration_sec')::numeric::int end),
      posting_options_at = now()
  where a.id = p_account_id and a.tenant_id = p_tenant_id and a.network = 'tiktok';
  if not found then
    raise exception 'Account not found' using errcode = 'P0002';
  end if;
end;
$$;

-- An owner or admin lets go of one login: its accounts are put out of use
-- (kept, so old posts still name them) and it leaves the connection's list.
-- Returns how many logins are left; the server then forgets its tokens, and
-- disconnects the connection when none are left.
create function public.forget_social_login(p_tenant_id uuid, p_provider text, p_login_id text)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_connection public.connections;
  v_left jsonb;
begin
  perform private.require_manager(p_tenant_id);
  if private.login_provider_networks(p_provider) is null then
    raise exception 'That login is not valid' using errcode = '22023';
  end if;
  select * into v_connection from public.connections c
  where c.tenant_id = p_tenant_id and c.provider = p_provider and c.status <> 'disconnected'
  for update;
  if not found then
    raise exception 'Not connected' using errcode = 'P0002';
  end if;
  update public.social_accounts a
  set active = false, offered = false, paused = false, needs_login = false
  where a.tenant_id = p_tenant_id and a.login_id = p_login_id
    and a.network = any (private.login_provider_networks(p_provider));
  select coalesce(jsonb_agg(l), '[]'::jsonb) into v_left
  from jsonb_array_elements(case when jsonb_typeof(v_connection.metadata -> 'logins') = 'array'
                                 then v_connection.metadata -> 'logins' else '[]'::jsonb end) l
  where l ->> 'id' is distinct from p_login_id;
  update public.connections c
  set metadata = c.metadata || jsonb_build_object('logins', v_left)
  where c.id = v_connection.id;
  perform private.log_audit(p_tenant_id, 'social.login_forgotten', 'connection', v_connection.id::text,
    jsonb_build_object('provider', p_provider));
  return jsonb_array_length(v_left);
end;
$$;

-- Disconnecting the whole connection puts its accounts aside (as for
-- Facebook): the ones in use come back when their login is connected again.
create function private.login_connection_accounts()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.provider not in ('tiktok', 'linkedin') then
    return new;
  end if;
  if new.status = 'disconnected' and old.status is distinct from 'disconnected' then
    update public.social_accounts a
    set paused = a.paused or a.active, active = false, offered = false
    where a.connection_id = new.id and (a.active or a.offered);
  end if;
  return new;
end;
$$;
revoke all on function private.login_connection_accounts() from public;
create trigger connections_login_accounts
  after update of status on public.connections
  for each row execute function private.login_connection_accounts();

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.note_login_accounts(uuid, text, text, jsonb)',
    'public.mark_social_login(uuid, text, text, boolean)',
    'public.note_social_account_options(uuid, uuid, jsonb)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
  execute 'revoke all on function public.forget_social_login(uuid, text, text) from public, anon';
  execute 'grant execute on function public.forget_social_login(uuid, text, text) to authenticated';
end;
$$;
