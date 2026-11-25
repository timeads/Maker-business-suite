-- Customers' photos and videos on a topic, a line for each case, joining two
-- topics and copying one under another label.
--
-- When a reading files a conversation under a topic, the customer's kept
-- pictures and videos from that conversation are offered on the topic as
-- CANDIDATES: ids only, pointing at `message_attachments`. A person on the
-- team picks which to keep, captions and orders them. Claude may point at
-- pictures it was shown and propose a caption; that is a mark on a candidate
-- (`suggested`), never a pick. A video is never shown to Claude and never
-- arrives with a caption.
--
-- Nothing here is public: the files stay in the private help desk bucket and
-- are served only by the route that checks who is asking. Nothing is copied
-- anywhere. When the attachment's row goes (its conversation deleted for
-- good, the customer forgotten), the entry here goes with it.
--
-- Who may do what:
--   the whole team   keeps, captions, orders and removes a topic's media;
--                    copies a topic under another label
--   owners, admins   join two topics
--   the worker       files a conversation's case line and candidates, only
--                    through apply_manual_reading

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- One line per source conversation: what happened and how it ended.
create table public.manual_topic_cases (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  topic_id uuid not null references public.manual_topics (id) on delete cascade,
  ticket_id uuid not null references public.tickets (id) on delete cascade,
  summary text not null check (char_length(summary) between 1 and 500),
  outcome text not null default '' check (char_length(outcome) <= 200),
  happened_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (topic_id, ticket_id)
);
create index manual_topic_cases_ticket_idx on public.manual_topic_cases (ticket_id);

create table public.manual_topic_media (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  topic_id uuid not null references public.manual_topics (id) on delete cascade,
  ticket_id uuid not null references public.tickets (id) on delete cascade,
  -- The file itself stays where it is. When its row goes, so does this one.
  attachment_id uuid not null references public.message_attachments (id) on delete cascade,
  kind text not null check (kind in ('image', 'video')),
  -- candidate: offered. kept: a person chose it. dismissed: a person said no
  -- (kept as a row so reading the conversation again doesn't offer it again).
  state text not null default 'candidate' check (state in ('candidate', 'kept', 'dismissed')),
  caption text not null default '' check (char_length(caption) <= 300),
  -- Claude pointed at this picture and proposed the caption. Never true of a video.
  suggested boolean not null default false check (not suggested or kind = 'image'),
  position int not null default 0,
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (topic_id, attachment_id)
);
create index manual_topic_media_topic_idx on public.manual_topic_media (topic_id, state, position);
create index manual_topic_media_attachment_idx on public.manual_topic_media (attachment_id);
create index manual_topic_media_ticket_idx on public.manual_topic_media (ticket_id);

do $$
declare
  t text;
begin
  foreach t in array array['manual_topic_cases', 'manual_topic_media']
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

-- What a reading found beside its points, kept with a suggested update until
-- a person decides: {"summary", "outcome"} and [{"attachment_id", ...}].
alter table public.manual_suggestions
  add column case_line jsonb,
  add column media jsonb;

alter table public.manual_topic_revisions
  drop constraint manual_topic_revisions_cause_check,
  add constraint manual_topic_revisions_cause_check check (cause in
    ('written', 'edited', 'ai_written', 'ai_added', 'suggestion', 'published', 'unpublished',
     'joined', 'copied'));

-- ---------------------------------------------------------------------------
-- Filing a conversation's case line and candidates
-- ---------------------------------------------------------------------------

-- A small piece of json from a reading, or null when it is too big to be one.
create function private.manual_small(p_value jsonb)
returns jsonb
language sql immutable set search_path = ''
as $$
  select case when p_value is null or jsonb_typeof(p_value) = 'null'
                   or char_length(p_value::text) > 8000 then null else p_value end;
$$;
revoke all on function private.manual_small(jsonb) from public;

-- `p_case` is {"summary", "outcome"}; `p_media` is [{"attachment_id",
-- "suggested", "caption"}]. Every attachment is checked here: it must be a
-- kept picture or video on a message the CUSTOMER sent in this conversation,
-- in this workspace. Anything else in the list is simply not filed. A person's
-- earlier choice (kept, dismissed, a caption they wrote) is never overwritten.
create function private.manual_file_case(
  p_tenant_id uuid, p_topic_id uuid, p_ticket_id uuid, p_case jsonb, p_media jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_summary text := private.manual_text(p_case ->> 'summary', 500);
  v_outcome text := private.manual_text(p_case ->> 'outcome', 200);
begin
  -- Read again, a conversation may land under another topic: the latest
  -- reading wins. What a person already chose to keep elsewhere stays.
  delete from public.manual_topic_cases c
  where c.ticket_id = p_ticket_id and c.topic_id <> p_topic_id;
  delete from public.manual_topic_media m
  where m.ticket_id = p_ticket_id and m.topic_id <> p_topic_id and m.state = 'candidate';

  if v_summary <> '' then
    insert into public.manual_topic_cases
      (tenant_id, topic_id, ticket_id, summary, outcome, happened_at)
    select p_tenant_id, p_topic_id, k.id, v_summary, v_outcome,
           coalesce(k.closed_at, k.last_message_at, k.created_at)
    from public.tickets k
    where k.id = p_ticket_id and k.tenant_id = p_tenant_id
    on conflict (topic_id, ticket_id) do update
      set summary = excluded.summary, outcome = excluded.outcome;
  end if;

  if p_media is not null and jsonb_typeof(p_media) = 'array' then
    insert into public.manual_topic_media
      (tenant_id, topic_id, ticket_id, attachment_id, kind, caption, suggested, position)
    select p_tenant_id, p_topic_id, p_ticket_id, f.id,
           case when f.mime_type like 'video/%' then 'video' else 'image' end,
           case when f.mime_type like 'image/%' and coalesce(x.item -> 'suggested' = 'true'::jsonb, false)
                then private.manual_text(x.item ->> 'caption', 300) else '' end,
           f.mime_type like 'image/%' and coalesce(x.item -> 'suggested' = 'true'::jsonb, false),
           x.ord::int
    from jsonb_array_elements(p_media) with ordinality as x(item, ord)
    join public.message_attachments f
      on f.id::text = x.item ->> 'attachment_id' and f.tenant_id = p_tenant_id
    join public.messages m
      on m.id = f.message_id and m.ticket_id = p_ticket_id and m.tenant_id = p_tenant_id
         and m.direction = 'inbound'
    where x.ord <= 20 and f.state = 'kept'
      and f.mime_type in ('image/jpeg', 'image/png', 'image/gif', 'image/webp',
                          'video/mp4', 'video/quicktime')
    on conflict (topic_id, attachment_id) do nothing;
  end if;
end;
$$;
revoke all on function private.manual_file_case(uuid, uuid, uuid, jsonb, jsonb) from public;

-- As before, and now a plan may also carry "case" and "media" (see above).
-- They are filed with the conversation's link to its topic; for a topic a
-- person has edited they wait with the suggested update.
create or replace function public.apply_manual_reading(p_run_id uuid, p_ticket_id uuid, p_plan jsonb)
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
        -- Its case line and photos wait with the suggestion: they are filed if it is accepted.
        insert into public.manual_suggestions
          (tenant_id, topic_id, additions, new_facets, ticket_ids, case_line, media)
        values (v_tenant, v_topic.id, coalesce(p_plan -> 'additions', '[]'::jsonb),
                private.manual_facets(p_plan -> 'new_facets'), array[p_ticket_id],
                private.manual_small(p_plan -> 'case'), private.manual_small(p_plan -> 'media'));
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
    perform private.manual_file_case(v_tenant, v_topic_id, p_ticket_id,
                                     p_plan -> 'case', p_plan -> 'media');
  end if;

  insert into public.manual_reads (tenant_id, ticket_id, result, run_id)
  values (v_tenant, p_ticket_id, v_result, p_run_id)
  on conflict (ticket_id) do update
    set result = excluded.result, run_id = excluded.run_id, read_at = now();
  return v_result;
end;
$$;

-- As before, and accepting a suggestion also files the case line and
-- candidates that came with it.
create or replace function public.decide_manual_suggestion(
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
    if cardinality(v_s.ticket_ids) > 0 then
      perform private.manual_file_case(p_tenant_id, v_s.topic_id, v_s.ticket_ids[1],
                                       v_s.case_line, v_s.media);
    end if;
    perform private.manual_keep_revision(v_s.topic_id, 'suggestion', auth.uid());
  end if;
  update public.manual_suggestions s
  set status = case when p_accept then 'accepted' else 'dismissed' end,
      decided_by = auth.uid(), decided_at = now()
  where s.id = v_s.id;
  return v_s.topic_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- What the team does with a topic's media
-- ---------------------------------------------------------------------------

-- Keeps a candidate, takes one off, or changes a caption. Null leaves a thing
-- as it is. A kept one goes to the end of the row the first time.
create function public.set_manual_topic_media(
  p_tenant_id uuid, p_media_id uuid, p_state text, p_caption text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_m public.manual_topic_media;
begin
  perform private.require_member(p_tenant_id);
  if p_state is not null and p_state not in ('kept', 'dismissed') then
    raise exception 'bad_state' using errcode = 'P0001';
  end if;
  select * into v_m from public.manual_topic_media m
  where m.id = p_media_id and m.tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  update public.manual_topic_media m
  set state = coalesce(p_state, m.state),
      caption = case when p_caption is null then m.caption
                     else private.manual_text(p_caption, 300) end,
      -- Once a person has kept it or written its caption, it is theirs.
      suggested = case when p_state = 'kept' or p_caption is not null then false
                       else m.suggested end,
      position = case when p_state = 'kept' and m.state <> 'kept'
                      then (select coalesce(max(o.position), 0) + 1
                            from public.manual_topic_media o
                            where o.topic_id = m.topic_id and o.state = 'kept')
                      else m.position end,
      decided_by = case when p_state is not null then auth.uid() else m.decided_by end,
      decided_at = case when p_state is not null then now() else m.decided_at end
  where m.id = p_media_id;
end;
$$;

-- The kept media in the order given. Ids that aren't this topic's are ignored.
create function public.order_manual_topic_media(
  p_tenant_id uuid, p_topic_id uuid, p_media_ids uuid[])
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_member(p_tenant_id);
  if cardinality(coalesce(p_media_ids, '{}')) > 200 then
    raise exception 'too_many' using errcode = 'P0001';
  end if;
  update public.manual_topic_media m
  set position = x.ord::int
  from unnest(p_media_ids) with ordinality as x(id, ord)
  where m.id = x.id and m.topic_id = p_topic_id and m.tenant_id = p_tenant_id
    and m.state = 'kept';
end;
$$;

-- ---------------------------------------------------------------------------
-- Joining two topics, and copying one under another label
-- ---------------------------------------------------------------------------

-- Folds `p_from` into `p_into` and removes it. The joined words and labels
-- are put together by the server (lib/helpdesk/manual/join.ts: nothing
-- written in either is changed) and handed over. Everything else moves
-- across here: both histories, the conversations, their case lines, the
-- media with what people decided about each, and suggested updates still
-- waiting. Owners and admins.
create function public.merge_manual_topics(
  p_tenant_id uuid, p_from uuid, p_into uuid, p_body jsonb, p_facets jsonb)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_from public.manual_topics;
  v_into public.manual_topics;
begin
  perform private.require_manager(p_tenant_id);
  if p_from is null or p_into is null or p_from = p_into then
    raise exception 'same_topic' using errcode = 'P0001';
  end if;
  -- Always in the same order, so two joins can't wait on each other.
  perform 1 from public.manual_topics t
  where t.id in (p_from, p_into) and t.tenant_id = p_tenant_id order by t.id for update;
  select * into v_from from public.manual_topics t where t.id = p_from and t.tenant_id = p_tenant_id;
  select * into v_into from public.manual_topics t where t.id = p_into and t.tenant_id = p_tenant_id;
  if v_from.id is null or v_into.id is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  update public.manual_topic_revisions r set topic_id = p_into where r.topic_id = p_from;

  insert into public.manual_topic_sources (tenant_id, topic_id, ticket_id, added_at)
  select p_tenant_id, p_into, s.ticket_id, s.added_at
  from public.manual_topic_sources s where s.topic_id = p_from
  on conflict do nothing;

  insert into public.manual_topic_cases
    (tenant_id, topic_id, ticket_id, summary, outcome, happened_at, created_at)
  select p_tenant_id, p_into, c.ticket_id, c.summary, c.outcome, c.happened_at, c.created_at
  from public.manual_topic_cases c where c.topic_id = p_from
  on conflict do nothing;

  -- A file both topics list keeps what was decided on the topic that stays.
  update public.manual_topic_media m
  set topic_id = p_into,
      position = m.position + (select coalesce(max(o.position), 0)
                               from public.manual_topic_media o where o.topic_id = p_into)
  where m.topic_id = p_from
    and not exists (select 1 from public.manual_topic_media o
                    where o.topic_id = p_into and o.attachment_id = m.attachment_id);

  update public.manual_suggestions s set topic_id = p_into
  where s.topic_id = p_from and s.status = 'pending';

  update public.manual_topics t
  set body = private.manual_doc(p_body), facets = private.manual_facets(p_facets),
      summary = case when btrim(t.summary) = '' then v_from.summary else t.summary end,
      person_edited_at = now(), updated_by = auth.uid(), updated_at = now()
  where t.id = p_into;
  delete from public.manual_topics t where t.id = p_from;
  perform private.manual_keep_revision(p_into, 'joined', auth.uid());
  return p_into;
end;
$$;

-- "Copy for another <label>": the same words as a new draft under different
-- labels, for a person to adapt. A copy and nothing more: no conversations,
-- case lines, photos or history come with it.
create function public.copy_manual_topic(
  p_tenant_id uuid, p_topic_id uuid, p_title text, p_facets jsonb)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_src public.manual_topics;
  v_title text := private.manual_text(p_title, 160);
begin
  perform private.require_member(p_tenant_id);
  select * into v_src from public.manual_topics t
  where t.id = p_topic_id and t.tenant_id = p_tenant_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  insert into public.manual_topics
    (tenant_id, title, summary, body, facets, status, source, person_edited_at,
     created_by, updated_by)
  values (p_tenant_id, case when v_title = '' then v_src.title else v_title end, v_src.summary,
          v_src.body, private.manual_facets(p_facets), 'draft', 'person', now(),
          auth.uid(), auth.uid())
  returning id into v_id;
  perform private.manual_keep_revision(v_id, 'copied', auth.uid());
  return v_id;
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
    'public.set_manual_topic_media(uuid, uuid, text, text)',
    'public.order_manual_topic_media(uuid, uuid, uuid[])',
    'public.merge_manual_topics(uuid, uuid, uuid, jsonb, jsonb)',
    'public.copy_manual_topic(uuid, uuid, text, jsonb)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;
