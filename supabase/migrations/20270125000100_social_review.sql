-- Social: review and approve. A post can wait for review, be approved (which
-- schedules it) or be sent back with a note. Who may approve is a workspace
-- setting (config social / review: `approvers`, owners and admins unless
-- changed), and so is whether a post must be approved before it can be
-- scheduled at all (`require_approval`, off unless switched on, which keeps
-- today's behaviour: anyone who can write can schedule).
--
-- Approval is always a person's press: the only ways a post becomes
-- scheduled are save_social_post (a person pressing Schedule) and the approve
-- functions below (a person pressing Approve), and where approval is required
-- a trigger refuses any scheduled post whose approver isn't allowed to
-- approve, however it got there. Nothing a model drafted is ever scheduled by
-- itself.

alter table public.social_posts
  -- 'waiting' for review, or 'sent_back' with a note. Only ever on a draft.
  add column review text check (review in ('waiting', 'sent_back')),
  add column review_note text check (review_note is null or char_length(review_note) <= 1000),
  add column submitted_by uuid references auth.users (id) on delete set null,
  add column submitted_at timestamptz,
  add column reviewed_by uuid references auth.users (id) on delete set null,
  add column reviewed_at timestamptz,
  -- Who said it could go out: whoever scheduled or approved it.
  add column approved_by uuid references auth.users (id) on delete set null,
  add column approved_at timestamptz,
  add constraint social_posts_review_on_drafts check (review is null or status = 'draft');
create index social_posts_review_idx on public.social_posts (tenant_id, review)
  where review is not null;

-- ---------------------------------------------------------------------------
-- The workspace's setting, read in the database
-- ---------------------------------------------------------------------------

create function private.social_requires_approval(p_tenant_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.configs c
    where c.tenant_id = p_tenant_id and c.module = 'social' and c.key = 'review'
      and c.body -> 'require_approval' = 'true'::jsonb);
$$;
revoke all on function private.social_requires_approval(uuid) from public;

-- Whether this person may approve posts in this workspace. Owners always may;
-- otherwise their role must be in the setting's `approvers` (owners and
-- admins when there is no setting, or it names nobody usable).
create function private.can_approve_social(p_tenant_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  with setting as (
    select coalesce(
      (select array_agg(r) from public.configs c,
         jsonb_array_elements_text(
           case when jsonb_typeof(c.body -> 'approvers') = 'array' then c.body -> 'approvers'
                else '[]'::jsonb end) as r
       where c.tenant_id = p_tenant_id and c.module = 'social' and c.key = 'review'
         and r in ('owner', 'admin', 'member')),
      array['owner', 'admin']) as roles
  )
  select exists (
    select 1 from public.memberships m, setting s
    where m.tenant_id = p_tenant_id and m.user_id = p_user_id
      and (m.role = 'owner' or m.role::text = any (s.roles)));
$$;
revoke all on function private.can_approve_social(uuid, uuid) from public;

-- Where approval is required, a post can only become scheduled with an
-- approver's name on it. A retry after a try that didn't finish (publishing
-- back to scheduled) is the worker's, and the post was approved before.
create function private.social_post_approval_check()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.status = 'scheduled'
     and (tg_op = 'INSERT' or old.status <> 'publishing')
     and private.social_requires_approval(new.tenant_id)
     and (new.approved_by is null or not private.can_approve_social(new.tenant_id, new.approved_by))
  then
    raise exception 'needs_approval' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function private.social_post_approval_check() from public;
create trigger social_posts_approval_check
  before insert or update on public.social_posts
  for each row execute function private.social_post_approval_check();

-- The rules a post must meet before it can be scheduled.
create function private.check_social_schedule(
  p_channels text[], p_caption text, p_has_photo boolean, p_at timestamptz
)
returns void
language plpgsql immutable set search_path = ''
as $$
begin
  if p_at is null then
    raise exception 'no_time' using errcode = 'P0001';
  end if;
  if cardinality(coalesce(p_channels, '{}')) = 0 then
    raise exception 'no_channel' using errcode = 'P0001';
  end if;
  if btrim(coalesce(p_caption, '')) = '' and not p_has_photo then
    raise exception 'empty' using errcode = 'P0001';
  end if;
  if 'instagram' = any (p_channels) and not p_has_photo then
    raise exception 'instagram_needs_photo' using errcode = 'P0001';
  end if;
end;
$$;
revoke all on function private.check_social_schedule(text[], text, boolean, timestamptz) from public;

-- ---------------------------------------------------------------------------
-- Saving: as before, plus who scheduled it. Where approval is required only
-- an approver can schedule; everyone else sends the post for review.
-- ---------------------------------------------------------------------------

create or replace function public.save_social_post(
  p_tenant_id uuid,
  p_post_id uuid,
  p_caption text,
  p_asset_id uuid,
  p_channels text[],
  p_scheduled_for timestamptz
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_channels text[] := coalesce(p_channels, '{}');
  v_caption text := btrim(coalesce(p_caption, ''));
  v_approver uuid;
begin
  if not (p_tenant_id in (select private.user_tenant_ids())) then
    raise exception 'Workspace not found' using errcode = '42501';
  end if;
  if p_asset_id is not null and not exists (
    select 1 from public.social_assets a where a.id = p_asset_id and a.tenant_id = p_tenant_id
  ) then
    raise exception 'Photo not found' using errcode = 'P0002';
  end if;

  if p_scheduled_for is not null then
    perform private.check_social_schedule(v_channels, v_caption, p_asset_id is not null, p_scheduled_for);
    if p_scheduled_for < now() - interval '5 minutes' then
      raise exception 'past' using errcode = 'P0001';
    end if;
    if private.social_requires_approval(p_tenant_id)
       and not private.can_approve_social(p_tenant_id, auth.uid()) then
      raise exception 'needs_approval' using errcode = 'P0001';
    end if;
    v_approver := auth.uid();
  end if;

  if p_post_id is null then
    insert into public.social_posts
      (tenant_id, caption, asset_id, channels, status, scheduled_for, created_by,
       approved_by, approved_at)
    values
      (p_tenant_id, v_caption, p_asset_id, v_channels,
       case when p_scheduled_for is null then 'draft' else 'scheduled' end::public.social_post_status,
       p_scheduled_for, auth.uid(),
       v_approver, case when v_approver is not null then now() end)
    returning id into v_id;
    return v_id;
  end if;

  update public.social_posts p
  set caption = v_caption, asset_id = p_asset_id, channels = v_channels,
      status = case when p_scheduled_for is null then 'draft' else 'scheduled' end::public.social_post_status,
      scheduled_for = p_scheduled_for,
      -- Scheduled is past review; a draft keeps where it was in review.
      review = case when p_scheduled_for is null then p.review end,
      review_note = case when p_scheduled_for is null then p.review_note end,
      approved_by = v_approver,
      approved_at = case when v_approver is not null then now() end,
      -- A fresh start: forget earlier failures, but never what already went out.
      error = null, attempts = 0, locked_at = null, results = '{}'::jsonb
  where p.id = p_post_id and p.tenant_id = p_tenant_id
    and p.status in ('draft', 'scheduled', 'failed')
    and not exists (select 1 from jsonb_each(p.results) r where r.value ->> 'id' is not null)
  returning p.id into v_id;
  if v_id is null then
    raise exception 'locked' using errcode = 'P0001';
  end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Review: send for review, send back with a note, approve one or many
-- ---------------------------------------------------------------------------

-- Anyone on the team can ask for a draft to be looked at.
create function public.submit_social_post(p_tenant_id uuid, p_post_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_member(p_tenant_id);
  update public.social_posts p
  set review = 'waiting', submitted_by = auth.uid(), submitted_at = now()
  where p.id = p_post_id and p.tenant_id = p_tenant_id and p.status = 'draft';
  if not found then
    raise exception 'locked' using errcode = 'P0001';
  end if;
end;
$$;

-- An approver sends a post back with a note saying what to change. A post
-- already scheduled (but not yet out) goes back to being a draft, pencilled
-- in for the time it had.
create function public.send_back_social_post(p_tenant_id uuid, p_post_id uuid, p_note text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_note text := btrim(coalesce(p_note, ''));
begin
  perform private.require_member(p_tenant_id);
  if not private.can_approve_social(p_tenant_id, auth.uid()) then
    raise exception 'not_approver' using errcode = '42501';
  end if;
  if v_note = '' then
    raise exception 'needs_note' using errcode = 'P0001';
  end if;
  update public.social_posts p
  set status = 'draft', review = 'sent_back', review_note = left(v_note, 1000),
      reviewed_by = auth.uid(), reviewed_at = now(),
      planned_for = coalesce(p.scheduled_for, p.planned_for), scheduled_for = null,
      approved_by = null, approved_at = null, error = null, attempts = 0, locked_at = null
  where p.id = p_post_id and p.tenant_id = p_tenant_id
    and p.status in ('draft', 'scheduled', 'failed')
    and not exists (select 1 from jsonb_each(p.results) r where r.value ->> 'id' is not null);
  if not found then
    raise exception 'locked' using errcode = 'P0001';
  end if;
end;
$$;

-- Approves one post as it is saved, scheduling it for `p_at` (or the time it
-- was pencilled in for). The caller is the approver; it checks nothing about
-- who they are, which the public functions do.
create function private.approve_social_post_row(p_tenant_id uuid, p_post_id uuid, p_at timestamptz)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_post public.social_posts;
  v_at timestamptz;
begin
  select * into v_post from public.social_posts p
  where p.id = p_post_id and p.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'Post not found' using errcode = 'P0002';
  end if;
  if v_post.status not in ('draft', 'failed')
     or exists (select 1 from jsonb_each(v_post.results) r where r.value ->> 'id' is not null) then
    raise exception 'locked' using errcode = 'P0001';
  end if;
  v_at := coalesce(p_at, v_post.planned_for);
  perform private.check_social_schedule(
    v_post.channels, v_post.caption,
    v_post.asset_id is not null or cardinality(v_post.asset_ids) > 0, v_at);
  if v_at < now() - interval '5 minutes' then
    raise exception 'past' using errcode = 'P0001';
  end if;
  update public.social_posts p
  set status = 'scheduled', scheduled_for = v_at, planned_for = null,
      review = null, review_note = null,
      reviewed_by = auth.uid(), reviewed_at = now(),
      approved_by = auth.uid(), approved_at = now(),
      error = null, attempts = 0, locked_at = null, results = '{}'::jsonb
  where p.id = p_post_id;
end;
$$;
revoke all on function private.approve_social_post_row(uuid, uuid, timestamptz) from public;

create function public.approve_social_post(p_tenant_id uuid, p_post_id uuid, p_at timestamptz)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_member(p_tenant_id);
  if not private.can_approve_social(p_tenant_id, auth.uid()) then
    raise exception 'not_approver' using errcode = '42501';
  end if;
  perform private.approve_social_post_row(p_tenant_id, p_post_id, p_at);
end;
$$;

-- "Approve all": the ticked posts, and/or every post waiting for review that
-- is pencilled in for a month ('YYYY-MM' on the workspace's clock). Each is
-- approved for the time it was pencilled in for, on its own: one that can't
-- go out is skipped with the reason and the rest still go. Up to 200 at once.
create function public.approve_social_posts(
  p_tenant_id uuid, p_post_ids uuid[], p_month text default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_tz text;
  v_ids uuid[];
  v_id uuid;
  v_approved uuid[] := '{}';
  v_skipped jsonb := '[]'::jsonb;
begin
  perform private.require_member(p_tenant_id);
  if not private.can_approve_social(p_tenant_id, auth.uid()) then
    raise exception 'not_approver' using errcode = '42501';
  end if;
  if p_month is not null and p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'bad_month' using errcode = '22023';
  end if;
  select t.timezone into v_tz from public.tenants t where t.id = p_tenant_id;

  select array(
    select distinct p.id from public.social_posts p
    where p.tenant_id = p_tenant_id
      and (p.id = any (coalesce(p_post_ids, '{}'))
           or (p_month is not null and p.review = 'waiting' and p.status = 'draft'
               and to_char(p.planned_for at time zone v_tz, 'YYYY-MM') = p_month))
    limit 201
  ) into v_ids;
  if cardinality(v_ids) > 200 then
    raise exception 'too_many' using errcode = 'P0001';
  end if;

  foreach v_id in array v_ids loop
    begin
      perform private.approve_social_post_row(p_tenant_id, v_id, null);
      v_approved := v_approved || v_id;
    exception when others then
      v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('approved', to_jsonb(v_approved), 'skipped', v_skipped);
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.submit_social_post(uuid, uuid)',
    'public.send_back_social_post(uuid, uuid, text)',
    'public.approve_social_post(uuid, uuid, timestamptz)',
    'public.approve_social_posts(uuid, uuid[], text)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;
