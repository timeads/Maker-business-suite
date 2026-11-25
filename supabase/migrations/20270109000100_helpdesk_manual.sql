-- The help desk's manual: topics written up from finished conversations (by
-- Claude on the worker, or by hand), and hand-written articles beside them.
-- What it is called, what feeds it and how often it runs is a setting
-- (configs: helpdesk / manual). Nothing here is shown to a customer.
--
-- Who may do what:
--   the whole team   reads everything; writes and edits topics and articles;
--                    accepts or dismisses a suggested update
--   owners, admins   publish, unpublish, delete; ask for an update now
--   the worker       claims a run, files what a reading found
-- Every write is a function below. A topic a person has edited is never
-- changed by a reading: `apply_manual_reading` files a suggestion instead.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.manual_topics (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 160),
  summary text not null default '' check (char_length(summary) <= 500),
  -- The suite's small document (lib/helpdesk/rich.ts), checked by the server
  -- before it gets here. A bold one-line paragraph is a section's heading.
  body jsonb not null default '[]'::jsonb
    check (jsonb_typeof(body) = 'array' and char_length(body::text) <= 200000),
  -- [{"facet", "value"}]: what the workspace sorts topics by (its own labels).
  facets jsonb not null default '[]'::jsonb
    check (jsonb_typeof(facets) = 'array' and jsonb_array_length(facets) <= 16),
  status text not null default 'draft' check (status in ('draft', 'published')),
  -- Who first wrote it: Claude from conversations, or a person.
  source text not null check (source in ('ai', 'person')),
  -- Whether published, it may be handed to a reply draft as reference.
  use_in_drafts boolean not null default true,
  -- Set the first time a person writes or changes it. From then on a reading
  -- never changes the topic; it files a suggestion.
  person_edited_at timestamptz,
  -- The last time a reading added to it.
  last_built_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index manual_topics_tenant_idx on public.manual_topics (tenant_id, updated_at desc);

-- Which conversations a topic drew on. Ids only: none of their words.
create table public.manual_topic_sources (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  topic_id uuid not null references public.manual_topics (id) on delete cascade,
  ticket_id uuid not null references public.tickets (id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (topic_id, ticket_id)
);
create index manual_topic_sources_ticket_idx on public.manual_topic_sources (ticket_id);

-- The topic as it stood after each change, and who or what made it.
create table public.manual_topic_revisions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  topic_id uuid not null references public.manual_topics (id) on delete cascade,
  title text not null,
  summary text not null,
  body jsonb not null,
  facets jsonb not null,
  status text not null,
  cause text not null check (cause in
    ('written', 'edited', 'ai_written', 'ai_added', 'suggestion', 'published', 'unpublished')),
  -- Null when no person did it: a reading on the worker.
  actor_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index manual_topic_revisions_topic_idx
  on public.manual_topic_revisions (topic_id, created_at desc);

-- What a reading would add to a topic a person has edited, waiting for a person.
create table public.manual_suggestions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  topic_id uuid not null references public.manual_topics (id) on delete cascade,
  -- [{"section", "points": [...]}]
  additions jsonb not null default '[]'::jsonb
    check (jsonb_typeof(additions) = 'array' and char_length(additions::text) <= 40000),
  -- [{"facet", "value"}]
  new_facets jsonb not null default '[]'::jsonb
    check (jsonb_typeof(new_facets) = 'array' and jsonb_array_length(new_facets) <= 16),
  ticket_ids uuid[] not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'accepted', 'dismissed')),
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index manual_suggestions_topic_idx on public.manual_suggestions (topic_id, status);
create index manual_suggestions_pending_idx on public.manual_suggestions (tenant_id)
  where status = 'pending';

-- One look at a workspace's source conversations. The same once-only queue as
-- the other worker jobs: claimed by one worker, tried once, and a run that
-- never finishes is marked failed, not run again.
create table public.manual_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'done', 'failed')),
  -- schedule: by itself. manual: "Update now". ticket: "Add to the manual" on one conversation.
  source text not null default 'schedule' check (source in ('schedule', 'manual', 'ticket')),
  ticket_id uuid references public.tickets (id) on delete cascade,
  requested_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  -- {"read", "written", "added", "suggested", "nothing", "failed", "stopped", "waiting"}
  counts jsonb not null default '{}'::jsonb check (jsonb_typeof(counts) = 'object'),
  error text check (error is null or char_length(error) <= 500),
  check ((source = 'ticket') = (ticket_id is not null))
);
create unique index manual_runs_one_open
  on public.manual_runs (tenant_id) where status in ('queued', 'running') and ticket_id is null;
create unique index manual_runs_one_open_ticket
  on public.manual_runs (tenant_id, ticket_id)
  where status in ('queued', 'running') and ticket_id is not null;
create index manual_runs_tenant_idx on public.manual_runs (tenant_id, created_at desc);

-- Conversations already read, so none is read (and paid for) twice.
create table public.manual_reads (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  ticket_id uuid primary key references public.tickets (id) on delete cascade,
  result text not null
    check (result in ('new', 'updated', 'suggested', 'seen', 'nothing', 'failed')),
  run_id uuid references public.manual_runs (id) on delete set null,
  read_at timestamptz not null default now()
);
create index manual_reads_tenant_idx on public.manual_reads (tenant_id, read_at desc);

-- Knowledge base: articles the team writes for itself.
create table public.manual_articles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 160),
  body jsonb not null default '[]'::jsonb
    check (jsonb_typeof(body) = 'array' and char_length(body::text) <= 200000),
  tags text[] not null default '{}' check (cardinality(tags) <= 12),
  -- A mark for the team: "fine to paste to a customer". Nothing publishes it.
  shareable boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index manual_articles_tenant_idx on public.manual_articles (tenant_id, updated_at desc);

do $$
declare
  t text;
begin
  foreach t in array array['manual_topics', 'manual_topic_sources', 'manual_topic_revisions',
                           'manual_suggestions', 'manual_runs', 'manual_reads', 'manual_articles']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy "members read their %s" on public.%I for select to authenticated
         using (tenant_id in (select private.user_tenant_ids()))', t, t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on public.%I to authenticated, service_role', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Small checks shared by the functions
-- ---------------------------------------------------------------------------

create function private.manual_text(p_text text, p_max int)
returns text
language sql immutable set search_path = ''
as $$
  select left(btrim(regexp_replace(coalesce(p_text, ''), '[[:cntrl:]]+', ' ', 'g')), p_max);
$$;
revoke all on function private.manual_text(text, int) from public;

create function private.manual_doc(p_doc jsonb)
returns jsonb
language plpgsql immutable set search_path = ''
as $$
begin
  if p_doc is null or jsonb_typeof(p_doc) <> 'array' or char_length(p_doc::text) > 200000 then
    raise exception 'bad_body' using errcode = 'P0001';
  end if;
  return p_doc;
end;
$$;
revoke all on function private.manual_doc(jsonb) from public;

create function private.manual_facets(p_facets jsonb)
returns jsonb
language plpgsql immutable set search_path = ''
as $$
begin
  if p_facets is null then
    return '[]'::jsonb;
  end if;
  if jsonb_typeof(p_facets) <> 'array' or jsonb_array_length(p_facets) > 16 then
    raise exception 'bad_facets' using errcode = 'P0001';
  end if;
  return p_facets;
end;
$$;
revoke all on function private.manual_facets(jsonb) from public;

create function private.manual_keep_revision(p_topic_id uuid, p_cause text, p_actor uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.manual_topic_revisions
    (tenant_id, topic_id, title, summary, body, facets, status, cause, actor_id)
  select t.tenant_id, t.id, t.title, t.summary, t.body, t.facets, t.status, p_cause, p_actor
  from public.manual_topics t where t.id = p_topic_id;
  -- The last sixty are kept.
  delete from public.manual_topic_revisions r
  where r.topic_id = p_topic_id
    and r.id not in (
      select k.id from public.manual_topic_revisions k
      where k.topic_id = p_topic_id order by k.created_at desc, k.id limit 60);
end;
$$;
revoke all on function private.manual_keep_revision(uuid, text, uuid) from public;

-- ---------------------------------------------------------------------------
-- What the team does
-- ---------------------------------------------------------------------------

-- Writes a new topic (p_topic_id null) or changes one. Either way a person
-- did it, so from here on readings only ever suggest.
create function public.save_manual_topic(
  p_tenant_id uuid, p_topic_id uuid, p_title text, p_summary text, p_body jsonb, p_facets jsonb)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_title text := private.manual_text(p_title, 160);
begin
  perform private.require_member(p_tenant_id);
  if v_title = '' then
    raise exception 'no_title' using errcode = 'P0001';
  end if;
  if p_topic_id is null then
    insert into public.manual_topics
      (tenant_id, title, summary, body, facets, source, person_edited_at, created_by, updated_by)
    values (p_tenant_id, v_title, private.manual_text(p_summary, 500), private.manual_doc(p_body),
            private.manual_facets(p_facets), 'person', now(), auth.uid(), auth.uid())
    returning id into v_id;
    perform private.manual_keep_revision(v_id, 'written', auth.uid());
    return v_id;
  end if;
  update public.manual_topics t
  set title = v_title, summary = private.manual_text(p_summary, 500),
      body = private.manual_doc(p_body), facets = private.manual_facets(p_facets),
      person_edited_at = now(), updated_by = auth.uid(), updated_at = now()
  where t.id = p_topic_id and t.tenant_id = p_tenant_id
  returning t.id into v_id;
  if v_id is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  perform private.manual_keep_revision(v_id, 'edited', auth.uid());
  return v_id;
end;
$$;

-- Publish or unpublish, and whether reply drafts may lean on it. Managers.
create function public.set_manual_topic_state(
  p_tenant_id uuid, p_topic_id uuid, p_status text, p_use_in_drafts boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_was text;
begin
  perform private.require_manager(p_tenant_id);
  if p_status is not null and p_status not in ('draft', 'published') then
    raise exception 'bad_status' using errcode = 'P0001';
  end if;
  select t.status into v_was from public.manual_topics t
  where t.id = p_topic_id and t.tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  update public.manual_topics t
  set status = coalesce(p_status, t.status),
      use_in_drafts = coalesce(p_use_in_drafts, t.use_in_drafts),
      updated_by = auth.uid(), updated_at = now()
  where t.id = p_topic_id;
  if p_status is not null and p_status <> v_was then
    perform private.manual_keep_revision(
      p_topic_id, case when p_status = 'published' then 'published' else 'unpublished' end,
      auth.uid());
  end if;
end;
$$;

-- Removes a topic for good, with its history. Its conversations stay marked
-- as read, so the next update doesn't write the same topic again.
create function public.delete_manual_topic(p_tenant_id uuid, p_topic_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_manager(p_tenant_id);
  delete from public.manual_topics t where t.id = p_topic_id and t.tenant_id = p_tenant_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
end;
$$;

-- Accepts a suggested update (with the topic as it should now read, which
-- the server put together and the person may have changed) or dismisses it.
create function public.decide_manual_suggestion(
  p_tenant_id uuid, p_suggestion_id uuid, p_accept boolean,
  p_body jsonb default null, p_facets jsonb default null)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_s public.manual_suggestions;
begin
  perform private.require_member(p_tenant_id);
  select * into v_s from public.manual_suggestions s
  where s.id = p_suggestion_id and s.tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_s.status <> 'pending' then
    return v_s.topic_id;
  end if;
  if p_accept then
    update public.manual_topics t
    set body = private.manual_doc(p_body),
        facets = private.manual_facets(coalesce(p_facets, t.facets)),
        person_edited_at = coalesce(t.person_edited_at, now()),
        last_built_at = now(), updated_by = auth.uid(), updated_at = now()
    where t.id = v_s.topic_id and t.tenant_id = p_tenant_id;
    insert into public.manual_topic_sources (tenant_id, topic_id, ticket_id)
    select p_tenant_id, v_s.topic_id, k.id
    from public.tickets k
    where k.id = any(v_s.ticket_ids) and k.tenant_id = p_tenant_id
    on conflict do nothing;
    perform private.manual_keep_revision(v_s.topic_id, 'suggestion', auth.uid());
  end if;
  update public.manual_suggestions s
  set status = case when p_accept then 'accepted' else 'dismissed' end,
      decided_by = auth.uid(), decided_at = now()
  where s.id = v_s.id;
  return v_s.topic_id;
end;
$$;

create function public.save_manual_article(
  p_tenant_id uuid, p_article_id uuid, p_title text, p_body jsonb, p_tags text[],
  p_shareable boolean)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_title text := private.manual_text(p_title, 160);
  v_tags text[];
begin
  perform private.require_member(p_tenant_id);
  if v_title = '' then
    raise exception 'no_title' using errcode = 'P0001';
  end if;
  select coalesce(array_agg(distinct x.tag), '{}') into v_tags
  from (select lower(private.manual_text(u.tag, 30)) as tag
        from unnest(coalesce(p_tags, '{}')) as u(tag)) x
  where x.tag <> '';
  if cardinality(v_tags) > 12 then
    raise exception 'too_many_tags' using errcode = 'P0001';
  end if;
  if p_article_id is null then
    insert into public.manual_articles
      (tenant_id, title, body, tags, shareable, created_by, updated_by)
    values (p_tenant_id, v_title, private.manual_doc(p_body), v_tags,
            coalesce(p_shareable, false), auth.uid(), auth.uid())
    returning id into v_id;
    return v_id;
  end if;
  update public.manual_articles a
  set title = v_title, body = private.manual_doc(p_body), tags = v_tags,
      shareable = coalesce(p_shareable, a.shareable), updated_by = auth.uid(), updated_at = now()
  where a.id = p_article_id and a.tenant_id = p_tenant_id
  returning a.id into v_id;
  if v_id is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  return v_id;
end;
$$;

create function public.delete_manual_article(p_tenant_id uuid, p_article_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_manager(p_tenant_id);
  delete from public.manual_articles a where a.id = p_article_id and a.tenant_id = p_tenant_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
end;
$$;

-- "Update now", or with a conversation named, "Add to the manual". Pressing
-- it while one is waiting or underway finds that one. A full update not more
-- than once in ten minutes or six times a day; single conversations not more
-- than thirty a day.
create function public.request_manual_run(p_tenant_id uuid, p_ticket_id uuid default null)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_manager(p_tenant_id);
  if p_ticket_id is not null and not exists (
    select 1 from public.tickets k where k.id = p_ticket_id and k.tenant_id = p_tenant_id
  ) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  select r.id into v_id from public.manual_runs r
  where r.tenant_id = p_tenant_id and r.status in ('queued', 'running')
    and r.ticket_id is not distinct from p_ticket_id;
  if found then
    return v_id;
  end if;
  if p_ticket_id is null then
    if exists (
      select 1 from public.manual_runs r
      where r.tenant_id = p_tenant_id and r.ticket_id is null
        and r.created_at > now() - interval '10 minutes'
    ) then
      raise exception 'too_soon' using errcode = 'P0001';
    end if;
    if (select count(*) from public.manual_runs r
        where r.tenant_id = p_tenant_id and r.source = 'manual'
          and r.created_at > now() - interval '24 hours') >= 6 then
      raise exception 'too_many' using errcode = 'P0001';
    end if;
  elsif (select count(*) from public.manual_runs r
         where r.tenant_id = p_tenant_id and r.source = 'ticket'
           and r.created_at > now() - interval '24 hours') >= 30 then
    raise exception 'too_many' using errcode = 'P0001';
  end if;
  begin
    insert into public.manual_runs (tenant_id, source, ticket_id, requested_by)
    values (p_tenant_id, case when p_ticket_id is null then 'manual' else 'ticket' end,
            p_ticket_id, auth.uid())
    returning id into v_id;
  exception when unique_violation then
    select r.id into v_id from public.manual_runs r
    where r.tenant_id = p_tenant_id and r.status in ('queued', 'running')
      and r.ticket_id is not distinct from p_ticket_id;
  end;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- What the worker does
-- ---------------------------------------------------------------------------

-- Whether a workspace asked for the manual to keep itself up to date, and
-- told it where to look.
create function private.manual_auto(p_body jsonb)
returns boolean
language sql immutable set search_path = ''
as $$
  select p_body -> 'auto' = 'true'::jsonb
    and coalesce((
      select sum(jsonb_array_length(p_body -> 'sources' -> k))
      from unnest(array['folders', 'views', 'tags']) as k
      where jsonb_typeof(p_body -> 'sources' -> k) = 'array'), 0) > 0;
$$;
revoke all on function private.manual_auto(jsonb) from public;

create function public.claim_manual_runs(p_limit int default 2)
returns table (id uuid, tenant_id uuid, source text, ticket_id uuid)
language plpgsql security definer set search_path = ''
as $$
begin
  update public.manual_runs r
  set status = 'failed', finished_at = now(), error = 'This update never finished.'
  where r.status = 'running' and r.started_at < now() - interval '30 minutes';

  delete from public.manual_runs r
  where r.status in ('done', 'failed') and r.created_at < now() - interval '60 days';

  -- By itself: once a day or once a week, for workspaces that switched it on.
  insert into public.manual_runs (tenant_id, source)
  select c.tenant_id, 'schedule'
  from public.configs c
  where c.module = 'helpdesk' and c.key = 'manual' and private.manual_auto(c.body)
    and not exists (
      select 1 from public.manual_runs r
      where r.tenant_id = c.tenant_id and r.ticket_id is null
        and (r.status in ('queued', 'running')
             or (r.source = 'schedule'
                 and r.created_at > now() - case when c.body ->> 'every' = 'week'
                                                 then interval '6 days 20 hours'
                                                 else interval '20 hours' end)))
  on conflict do nothing;

  return query
  with due as (
    select r.id from public.manual_runs r
    where r.status = 'queued'
    order by r.created_at
    limit greatest(1, least(coalesce(p_limit, 2), 10))
    for update skip locked
  )
  update public.manual_runs r set status = 'running', started_at = now()
  from due where r.id = due.id
  returning r.id, r.tenant_id, r.source, r.ticket_id;
end;
$$;

create function public.finish_manual_run(
  p_id uuid, p_status text, p_counts jsonb, p_error text default null)
returns void
language sql security definer set search_path = ''
as $$
  update public.manual_runs r
  set status = case when p_status = 'done' then 'done' else 'failed' end,
      finished_at = now(), counts = coalesce(p_counts, '{}'::jsonb), error = left(p_error, 500)
  where r.id = p_id and r.status = 'running';
$$;

-- The ONLY way a reading reaches the manual. `p_plan` is what the code
-- decided (lib/helpdesk/manual/plan.ts):
--   {"kind": "new", "title", "summary", "body", "facets"}
--   {"kind": "update", "topic_id", "summary", "body", "facets", "additions", "new_facets"}
--   {"kind": "suggest", "topic_id", "additions", "new_facets"}
--   {"kind": "seen", "topic_id"} | {"kind": "nothing"} | {"kind": "failed"}
-- An "update" for a topic a person has edited in the meantime is filed as a
-- suggestion: the check is made here, under the row's lock.
create function public.apply_manual_reading(p_run_id uuid, p_ticket_id uuid, p_plan jsonb)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant uuid;
  v_kind text := coalesce(p_plan ->> 'kind', 'nothing');
  v_topic public.manual_topics;
  v_topic_id uuid;
  v_result text;
begin
  select r.tenant_id into v_tenant from public.manual_runs r
  where r.id = p_run_id and r.status = 'running';
  if not found then
    raise exception 'run_not_running' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.tickets k where k.id = p_ticket_id and k.tenant_id = v_tenant
  ) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  if v_kind = 'new' then
    if private.manual_text(p_plan ->> 'title', 160) = '' then
      v_result := 'nothing';
    else
      insert into public.manual_topics
        (tenant_id, title, summary, body, facets, source, last_built_at)
      values (v_tenant, private.manual_text(p_plan ->> 'title', 160),
              private.manual_text(p_plan ->> 'summary', 500),
              private.manual_doc(p_plan -> 'body'), private.manual_facets(p_plan -> 'facets'),
              'ai', now())
      returning id into v_topic_id;
      perform private.manual_keep_revision(v_topic_id, 'ai_written', null);
      v_result := 'new';
    end if;
  elsif v_kind in ('update', 'suggest', 'seen') then
    select * into v_topic from public.manual_topics t
    where t.id = (p_plan ->> 'topic_id')::uuid and t.tenant_id = v_tenant for update;
    if not found then
      v_result := 'nothing';
    else
      v_topic_id := v_topic.id;
      if v_kind = 'seen' then
        v_result := 'seen';
      elsif v_kind = 'update' and v_topic.person_edited_at is null then
        update public.manual_topics t
        set summary = private.manual_text(p_plan ->> 'summary', 500),
            body = private.manual_doc(p_plan -> 'body'),
            facets = private.manual_facets(p_plan -> 'facets'),
            last_built_at = now(), updated_at = now()
        where t.id = v_topic.id;
        perform private.manual_keep_revision(v_topic.id, 'ai_added', null);
        v_result := 'updated';
      else
        -- A person has edited it: what the reading found waits for a person.
        delete from public.manual_suggestions s
        where s.topic_id = v_topic.id and s.status = 'pending'
          and s.ticket_ids = array[p_ticket_id];
        insert into public.manual_suggestions
          (tenant_id, topic_id, additions, new_facets, ticket_ids)
        values (v_tenant, v_topic.id, coalesce(p_plan -> 'additions', '[]'::jsonb),
                private.manual_facets(p_plan -> 'new_facets'), array[p_ticket_id]);
        v_result := 'suggested';
      end if;
    end if;
  elsif v_kind = 'failed' then
    v_result := 'failed';
  else
    v_result := 'nothing';
  end if;

  if v_result in ('new', 'updated', 'seen') then
    -- Read again, a conversation may land somewhere else: the latest reading wins.
    delete from public.manual_topic_sources s
    where s.ticket_id = p_ticket_id and s.topic_id <> v_topic_id;
    insert into public.manual_topic_sources (tenant_id, topic_id, ticket_id)
    values (v_tenant, v_topic_id, p_ticket_id)
    on conflict do nothing;
  end if;

  insert into public.manual_reads (tenant_id, ticket_id, result, run_id)
  values (v_tenant, p_ticket_id, v_result, p_run_id)
  on conflict (ticket_id) do update
    set result = excluded.result, run_id = excluded.run_id, read_at = now();
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.claim_manual_runs(int)',
    'public.finish_manual_run(uuid, text, jsonb, text)',
    'public.apply_manual_reading(uuid, uuid, jsonb)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
  foreach fn in array array[
    'public.save_manual_topic(uuid, uuid, text, text, jsonb, jsonb)',
    'public.set_manual_topic_state(uuid, uuid, text, boolean)',
    'public.delete_manual_topic(uuid, uuid)',
    'public.decide_manual_suggestion(uuid, uuid, boolean, jsonb, jsonb)',
    'public.save_manual_article(uuid, uuid, text, jsonb, text[], boolean)',
    'public.delete_manual_article(uuid, uuid)',
    'public.request_manual_run(uuid, uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;
