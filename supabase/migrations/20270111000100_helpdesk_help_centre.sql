-- A help centre customers can read: public pages on the suite's own site,
-- drawn from the manual's articles. An article gains a public state
-- (internal, the default; a public draft; published), an address of its own,
-- a category, a line for lists and search, pictures of its own, and a count
-- of "Was this helpful?" answers.
--
-- What a signed-out visitor can reach is decided here, not in a page:
-- the three `help_centre_*` read functions return published articles of one
-- named workspace, and only while that workspace has its help centre
-- switched on (configs: helpdesk / help_centre). Topics, internal articles,
-- drafts and customers' files are in no function a visitor's request reaches.
--
-- Who may do what:
--   the whole team   writes and edits an article that is NOT published
--   owners, admins   make an article public, publish, unpublish, and change
--                    anything about one that is published
--   the server       files a checked picture, reads for the public pages

-- ---------------------------------------------------------------------------
-- Pictures: a PUBLIC bucket of the articles' own pictures, apart from the
-- private `helpdesk` bucket that holds what customers sent. Paths are
-- <workspace>/<article>/<random id>.<ext>, written only by the server.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('help-centre', 'help-centre', true, 8388608,
        array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Articles
-- ---------------------------------------------------------------------------

alter table public.manual_articles
  add column public_state text not null default 'internal'
    check (public_state in ('internal', 'draft', 'published')),
  -- The last part of its address. One of a kind in a workspace (see
  -- help_article_slugs, which also remembers the ones it used to have).
  add column slug text
    check (slug is null or slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 80),
  -- One of the workspace's own categories (configs: helpdesk / help_centre), by id.
  add column category text check (category is null or category ~ '^[a-z0-9-]{1,30}$'),
  -- For lists, search results and the page's description.
  add column summary text not null default '' check (char_length(summary) <= 300),
  add column published_at timestamptz,
  -- "Last updated" as customers see it: when it was published or its words last changed since.
  add column public_updated_at timestamptz,
  add column helpful_yes int not null default 0 check (helpful_yes >= 0),
  add column helpful_no int not null default 0 check (helpful_no >= 0),
  add constraint manual_articles_published_has_slug
    check (public_state <> 'published' or slug is not null);
create unique index manual_articles_slug_idx on public.manual_articles (tenant_id, slug)
  where slug is not null;
create index manual_articles_public_idx on public.manual_articles (tenant_id)
  where public_state = 'published';

-- Every address an article has had. The current one is on the article; the
-- others send a visitor on to it. An address is never handed to a second
-- article while the first is still here.
create table public.help_article_slugs (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 80),
  article_id uuid not null references public.manual_articles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (tenant_id, slug)
);
create index help_article_slugs_article_idx on public.help_article_slugs (article_id);

create table public.help_article_pictures (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  article_id uuid not null references public.manual_articles (id) on delete cascade,
  storage_path text not null unique,
  -- What the file's own bytes said it was when the server looked.
  mime_type text not null
    check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'image/gif')),
  bytes int not null check (bytes > 0 and bytes <= 8388608),
  -- What the picture shows, for people who can't see it.
  alt text not null default '' check (char_length(alt) <= 200),
  caption text not null default '' check (char_length(caption) <= 300),
  -- The heading it sits under; '' puts it above the first heading.
  section text not null default '' check (char_length(section) <= 160),
  position int not null default 0,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  check (storage_path like tenant_id::text || '/' || article_id::text || '/%')
);
create index help_article_pictures_article_idx
  on public.help_article_pictures (article_id, position, created_at);

do $$
declare
  t text;
begin
  foreach t in array array['help_article_slugs', 'help_article_pictures']
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

-- Files to take out of the public bucket once their row is gone, however it
-- went (the article deleted, the workspace removed). The worker empties it.
create table private.help_picture_removals (
  storage_path text primary key,
  queued_at timestamptz not null default now(),
  locked_at timestamptz
);
alter table private.help_picture_removals enable row level security;
revoke all on private.help_picture_removals from public, anon, authenticated, service_role;

create function private.queue_help_picture_removal()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into private.help_picture_removals (storage_path) values (old.storage_path)
  on conflict do nothing;
  return old;
end;
$$;
revoke all on function private.queue_help_picture_removal() from public;
create trigger help_article_pictures_removed
  after delete on public.help_article_pictures
  for each row execute function private.queue_help_picture_removal();

create function public.claim_help_picture_removals(p_limit int default 100)
returns setof text
language sql security definer set search_path = ''
as $$
  update private.help_picture_removals r
  set locked_at = now()
  where r.storage_path in (
    select s.storage_path from private.help_picture_removals s
    where s.locked_at is null or s.locked_at < now() - interval '15 minutes'
    order by s.queued_at
    limit greatest(1, least(coalesce(p_limit, 100), 500))
    for update skip locked)
  returning r.storage_path;
$$;

create function public.finish_help_picture_removals(p_paths text[])
returns void
language sql security definer set search_path = ''
as $$
  delete from private.help_picture_removals r where r.storage_path = any (p_paths);
$$;

-- How often one visitor may search or answer "Was this helpful?". The key is
-- a salted fingerprint the server works out; no address is ever stored.
create table private.help_centre_hits (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  kind text not null check (char_length(kind) <= 60),
  key text not null check (char_length(key) <= 64),
  window_start timestamptz not null default now(),
  hits int not null default 1,
  primary key (tenant_id, kind, key)
);
alter table private.help_centre_hits enable row level security;
revoke all on private.help_centre_hits from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Small helpers
-- ---------------------------------------------------------------------------

-- "How do I clean it?" -> "how-do-i-clean-it".
create function private.help_slug(p_text text)
returns text
language sql immutable set search_path = ''
as $$
  select coalesce(nullif(btrim(left(btrim(
    regexp_replace(lower(coalesce(p_text, '')), '[^a-z0-9]+', '-', 'g'), '-'), 60), '-'), ''),
    'article');
$$;
revoke all on function private.help_slug(text) from public;

create function private.help_centre_on(p_tenant_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.configs c
    where c.tenant_id = p_tenant_id and c.module = 'helpdesk' and c.key = 'help_centre'
      and c.body -> 'on' = 'true'::jsonb);
$$;
revoke all on function private.help_centre_on(uuid) from public;

-- Locks the article and checks the caller may change it: anyone on the team
-- while it isn't published, owners and admins once it is. `p_user` names the
-- person when the server is acting for them (a checked upload).
create function private.help_article_for_change(
  p_tenant_id uuid, p_article_id uuid, p_user uuid default null)
returns public.manual_articles
language plpgsql security definer set search_path = ''
as $$
declare
  v_a public.manual_articles;
  v_user uuid := coalesce(p_user, auth.uid());
  v_role public.membership_role;
begin
  select m.role into v_role from public.memberships m
  where m.tenant_id = p_tenant_id and m.user_id = v_user;
  if v_user is null or v_role is null then
    raise exception 'Workspace not found' using errcode = '42501';
  end if;
  select * into v_a from public.manual_articles a
  where a.id = p_article_id and a.tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_a.public_state = 'published' and v_role not in ('owner', 'admin') then
    raise exception 'Only owners and admins can change a published article'
      using errcode = '42501';
  end if;
  return v_a;
end;
$$;
revoke all on function private.help_article_for_change(uuid, uuid, uuid) from public;

-- Gives the article an address. A wanted one that another article has (or
-- had) is refused; with none wanted, one is made from the title and numbered
-- until it is free.
create function private.help_claim_slug(
  p_tenant_id uuid, p_article_id uuid, p_wanted text, p_title text)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_base text;
  v_slug text;
  v_n int := 1;
  v_owner uuid;
begin
  if p_wanted is not null and btrim(p_wanted) <> '' then
    v_slug := lower(btrim(p_wanted));
    if v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(v_slug) > 80 then
      raise exception 'bad_slug' using errcode = 'P0001';
    end if;
    select s.article_id into v_owner from public.help_article_slugs s
    where s.tenant_id = p_tenant_id and s.slug = v_slug;
    if found and v_owner <> p_article_id then
      raise exception 'slug_taken' using errcode = 'P0001';
    end if;
  else
    v_base := private.help_slug(p_title);
    v_slug := v_base;
    loop
      select s.article_id into v_owner from public.help_article_slugs s
      where s.tenant_id = p_tenant_id and s.slug = v_slug;
      exit when not found or v_owner = p_article_id;
      v_n := v_n + 1;
      v_slug := left(v_base, 70) || '-' || v_n;
    end loop;
  end if;
  insert into public.help_article_slugs (tenant_id, slug, article_id)
  values (p_tenant_id, v_slug, p_article_id)
  on conflict do nothing;
  update public.manual_articles a set slug = v_slug where a.id = p_article_id;
  return v_slug;
end;
$$;
revoke all on function private.help_claim_slug(uuid, uuid, text, text) from public;

-- ---------------------------------------------------------------------------
-- What the team does
-- ---------------------------------------------------------------------------

-- As before, with one more rule: a published article is on a public page, so
-- only owners and admins change its words, and the change moves its
-- "last updated" date.
create or replace function public.save_manual_article(
  p_tenant_id uuid, p_article_id uuid, p_title text, p_body jsonb, p_tags text[],
  p_shareable boolean)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_title text := private.manual_text(p_title, 160);
  v_tags text[];
  v_was public.manual_articles;
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
  v_was := private.help_article_for_change(p_tenant_id, p_article_id);
  update public.manual_articles a
  set title = v_title, body = private.manual_doc(p_body), tags = v_tags,
      shareable = coalesce(p_shareable, a.shareable), updated_by = auth.uid(), updated_at = now(),
      public_updated_at = case
        when a.public_state = 'published'
             and (a.title <> v_title or a.body <> private.manual_doc(p_body))
        then now() else a.public_updated_at end
  where a.id = p_article_id and a.tenant_id = p_tenant_id
  returning a.id into v_id;
  return v_id;
end;
$$;

-- Its address, category and the line for lists. A null address leaves it as
-- it is (or makes one from the title when it has none yet).
create function public.save_help_article_details(
  p_tenant_id uuid, p_article_id uuid, p_slug text, p_category text, p_summary text)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_a public.manual_articles;
  v_slug text;
  v_category text := nullif(btrim(coalesce(p_category, '')), '');
  v_summary text := private.manual_text(p_summary, 300);
begin
  v_a := private.help_article_for_change(p_tenant_id, p_article_id);
  if v_category is not null and v_category !~ '^[a-z0-9-]{1,30}$' then
    raise exception 'bad_category' using errcode = 'P0001';
  end if;
  v_slug := v_a.slug;
  if nullif(btrim(coalesce(p_slug, '')), '') is not null
     and lower(btrim(p_slug)) is distinct from v_a.slug then
    v_slug := private.help_claim_slug(p_tenant_id, p_article_id, p_slug, v_a.title);
  elsif v_a.slug is null and v_a.public_state <> 'internal' then
    v_slug := private.help_claim_slug(p_tenant_id, p_article_id, null, v_a.title);
  end if;
  update public.manual_articles a
  set category = v_category, summary = v_summary, updated_by = auth.uid(), updated_at = now(),
      public_updated_at = case
        when a.public_state = 'published'
             and (a.summary <> v_summary or a.category is distinct from v_category
                  or a.slug is distinct from v_slug)
        then now() else a.public_updated_at end
  where a.id = p_article_id;
  return v_slug;
end;
$$;

-- internal -> draft (a help article in the making) -> published, and back.
-- Owners and admins only, every step.
create function public.set_help_article_state(
  p_tenant_id uuid, p_article_id uuid, p_state text)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_a public.manual_articles;
  v_slug text;
begin
  perform private.require_manager(p_tenant_id);
  if p_state is null or p_state not in ('internal', 'draft', 'published') then
    raise exception 'bad_state' using errcode = 'P0001';
  end if;
  select * into v_a from public.manual_articles a
  where a.id = p_article_id and a.tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  v_slug := v_a.slug;
  if p_state <> 'internal' and v_slug is null then
    v_slug := private.help_claim_slug(p_tenant_id, p_article_id, null, v_a.title);
  end if;
  update public.manual_articles a
  set public_state = p_state,
      published_at = case when p_state = 'published'
                          then coalesce(a.published_at, now()) else a.published_at end,
      public_updated_at = case when p_state = 'published' and a.public_state <> 'published'
                               then now() else a.public_updated_at end,
      updated_by = auth.uid(), updated_at = now()
  where a.id = p_article_id;
  perform private.log_audit(p_tenant_id, 'help_article.' || p_state, 'manual_article',
                            p_article_id::text);
  return v_slug;
end;
$$;

-- A new public DRAFT with the words handed over: "Make a help article from
-- this topic" (the server reads the topic and passes its text) and a draft
-- Claude wrote. A copy, with no tie back to where the words came from, and
-- no pictures.
create function public.start_help_article(
  p_tenant_id uuid, p_title text, p_summary text, p_body jsonb)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_title text := private.manual_text(p_title, 160);
begin
  perform private.require_manager(p_tenant_id);
  if v_title = '' then
    raise exception 'no_title' using errcode = 'P0001';
  end if;
  insert into public.manual_articles
    (tenant_id, title, body, summary, public_state, created_by, updated_by)
  values (p_tenant_id, v_title, private.manual_doc(p_body), private.manual_text(p_summary, 300),
          'draft', auth.uid(), auth.uid())
  returning id into v_id;
  perform private.help_claim_slug(p_tenant_id, v_id, null, v_title);
  return v_id;
end;
$$;

-- A picture the server has looked at (its real type and size, its path under
-- this workspace and article) is listed for the article. Up to twelve.
create function public.register_help_article_picture(
  p_tenant_id uuid, p_article_id uuid, p_user uuid, p_storage_path text, p_mime_type text,
  p_bytes int)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_next int;
begin
  perform private.help_article_for_change(p_tenant_id, p_article_id, p_user);
  select coalesce(max(p.position), 0) + 1 into v_next
  from public.help_article_pictures p where p.article_id = p_article_id;
  if (select count(*) from public.help_article_pictures p where p.article_id = p_article_id) >= 12 then
    raise exception 'too_many_pictures' using errcode = 'P0001';
  end if;
  insert into public.help_article_pictures
    (tenant_id, article_id, storage_path, mime_type, bytes, position, created_by)
  values (p_tenant_id, p_article_id, p_storage_path, p_mime_type, p_bytes, v_next, p_user)
  returning id into v_id;
  update public.manual_articles a
  set updated_at = now(),
      public_updated_at = case when a.public_state = 'published' then now()
                               else a.public_updated_at end
  where a.id = p_article_id;
  return v_id;
end;
$$;

-- What a picture shows, its caption, the heading it sits under and its place.
create function public.save_help_article_picture(
  p_tenant_id uuid, p_picture_id uuid, p_alt text, p_caption text, p_section text,
  p_position int)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_article uuid;
begin
  perform private.require_member(p_tenant_id);
  select p.article_id into v_article from public.help_article_pictures p
  where p.id = p_picture_id and p.tenant_id = p_tenant_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  perform private.help_article_for_change(p_tenant_id, v_article);
  update public.help_article_pictures p
  set alt = private.manual_text(p_alt, 200), caption = private.manual_text(p_caption, 300),
      section = private.manual_text(p_section, 160),
      position = coalesce(p_position, p.position)
  where p.id = p_picture_id;
  update public.manual_articles a
  set updated_at = now(),
      public_updated_at = case when a.public_state = 'published' then now()
                               else a.public_updated_at end
  where a.id = v_article;
end;
$$;

-- Takes a picture off its article. The file follows (the removals queue).
create function public.remove_help_article_picture(p_tenant_id uuid, p_picture_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_article uuid;
begin
  perform private.require_member(p_tenant_id);
  select p.article_id into v_article from public.help_article_pictures p
  where p.id = p_picture_id and p.tenant_id = p_tenant_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  perform private.help_article_for_change(p_tenant_id, v_article);
  delete from public.help_article_pictures p where p.id = p_picture_id;
  update public.manual_articles a
  set updated_at = now(),
      public_updated_at = case when a.public_state = 'published' then now()
                               else a.public_updated_at end
  where a.id = v_article;
end;
$$;

-- ---------------------------------------------------------------------------
-- What the public pages read. Service role only, always for one named
-- workspace, and nothing but published articles of a help centre that is on.
-- ---------------------------------------------------------------------------

create function public.help_centre_list(p_tenant_id uuid)
returns table (id uuid, slug text, title text, summary text, category text, body jsonb,
               updated_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select a.id, a.slug, a.title, a.summary, a.category, a.body,
         coalesce(a.public_updated_at, a.published_at, a.updated_at)
  from public.manual_articles a
  where a.tenant_id = p_tenant_id and a.public_state = 'published' and a.slug is not null
    and private.help_centre_on(p_tenant_id)
  order by a.title
  limit 300;
$$;

-- One article by its address, or by one it used to have (the answer carries
-- the address it has now, so the page can send the visitor on). Null for
-- anything else: a draft, an internal article, another workspace's, a guess.
create function public.help_centre_article(p_tenant_id uuid, p_slug text)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'id', a.id, 'slug', a.slug, 'title', a.title, 'summary', a.summary,
    'category', a.category, 'body', a.body,
    'updated_at', coalesce(a.public_updated_at, a.published_at, a.updated_at),
    'published_at', a.published_at,
    'pictures', coalesce((
      select jsonb_agg(jsonb_build_object(
               'path', p.storage_path, 'alt', p.alt, 'caption', p.caption, 'section', p.section)
             order by p.position, p.created_at)
      from public.help_article_pictures p where p.article_id = a.id), '[]'::jsonb))
  from public.help_article_slugs s
  join public.manual_articles a on a.id = s.article_id and a.tenant_id = s.tenant_id
  where s.tenant_id = p_tenant_id and s.slug = p_slug
    and a.public_state = 'published' and a.slug is not null
    and private.help_centre_on(p_tenant_id);
$$;

-- Counts one more of this kind from this visitor and says whether that is
-- still within the limit. A new window starts when the old one has run out.
create function public.help_centre_allow(
  p_tenant_id uuid, p_kind text, p_key text, p_limit int, p_seconds int)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_hits int;
begin
  if p_tenant_id is null or coalesce(p_key, '') = '' or coalesce(p_kind, '') = '' then
    return false;
  end if;
  if random() < 0.02 then
    delete from private.help_centre_hits h where h.window_start < now() - interval '2 days';
  end if;
  insert into private.help_centre_hits as h (tenant_id, kind, key)
  values (p_tenant_id, left(p_kind, 60), left(p_key, 64))
  on conflict (tenant_id, kind, key) do update
    set hits = case when h.window_start < now() - make_interval(secs => greatest(p_seconds, 1))
                    then 1 else h.hits + 1 end,
        window_start = case when h.window_start < now() - make_interval(secs => greatest(p_seconds, 1))
                            then now() else h.window_start end
  returning h.hits into v_hits;
  return v_hits <= greatest(p_limit, 1);
end;
$$;

-- "Was this helpful?": one more yes or no on a published article. The server
-- has already asked help_centre_allow whether this visitor may answer.
create function public.help_centre_vote(p_tenant_id uuid, p_slug text, p_helpful boolean)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  if p_helpful is null or not private.help_centre_on(p_tenant_id) then
    return false;
  end if;
  update public.manual_articles a
  set helpful_yes = a.helpful_yes + case when p_helpful then 1 else 0 end,
      helpful_no = a.helpful_no + case when p_helpful then 0 else 1 end
  where a.tenant_id = p_tenant_id and a.slug = p_slug and a.public_state = 'published';
  return found;
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
    'public.help_centre_list(uuid)',
    'public.help_centre_article(uuid, text)',
    'public.help_centre_allow(uuid, text, text, int, int)',
    'public.help_centre_vote(uuid, text, boolean)',
    'public.register_help_article_picture(uuid, uuid, uuid, text, text, int)',
    'public.claim_help_picture_removals(int)',
    'public.finish_help_picture_removals(text[])'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
  foreach fn in array array[
    'public.save_help_article_details(uuid, uuid, text, text, text)',
    'public.set_help_article_state(uuid, uuid, text)',
    'public.start_help_article(uuid, text, text, jsonb)',
    'public.save_help_article_picture(uuid, uuid, text, text, text, int)',
    'public.remove_help_article_picture(uuid, uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;
