-- Social: learning from edits.
--
-- When a post Claude drafted (`social_posts.ai_draft`) is saved with a
-- caption that differs from what Claude wrote, the before and after are kept
-- here, one row per post and caption (the main caption is 'main'; a
-- caption of its own for one account is that account's id). The row follows
-- the latest save, and goes when the words are back to Claude's. Written ONLY
-- by the trigger below: nobody writes this table directly, and the browser
-- never hands it a "before".
--
-- What people do with it: "Suggest notes from my edits" (owners and admins)
-- has Claude read recent rows and propose style notes, which a person reads,
-- changes and saves (config social / style_notes); drafting is shown a few
-- recent before-and-after pairs as examples.

create table public.social_post_edits (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  brand_id uuid references public.brands (id) on delete set null,
  post_id uuid not null references public.social_posts (id) on delete cascade,
  -- 'main', or the account id whose own caption this is.
  which text not null check (which = 'main' or which ~ '^[0-9a-f-]{36}$'),
  before text not null check (char_length(before) between 1 and 2200),
  after text not null check (char_length(after) between 1 and 2200),
  edited_by uuid references auth.users (id) on delete set null,
  edited_at timestamptz not null default now(),
  unique (post_id, which)
);
create index social_post_edits_tenant_idx
  on public.social_post_edits (tenant_id, brand_id, edited_at desc);

alter table public.social_post_edits enable row level security;
create policy "members read their social post edits" on public.social_post_edits
  for select to authenticated using (tenant_id in (select private.user_tenant_ids()));
revoke all on public.social_post_edits from public, anon, authenticated, service_role;
grant select on public.social_post_edits to authenticated, service_role;

-- Keeps one caption's edit in step: written when it differs from Claude's
-- draft, removed when it doesn't (or is empty).
create function private.note_social_caption_edit(
  p_post public.social_posts, p_which text, p_after text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_before text := left(btrim(coalesce(p_post.ai_draft, '')), 2200);
  v_after text := left(btrim(coalesce(p_after, '')), 2200);
begin
  if v_before = '' or v_after = '' or v_after = v_before then
    delete from public.social_post_edits e where e.post_id = p_post.id and e.which = p_which;
    return;
  end if;
  insert into public.social_post_edits
    (tenant_id, brand_id, post_id, which, before, after, edited_by, edited_at)
  values
    (p_post.tenant_id, p_post.brand_id, p_post.id, p_which, v_before, v_after, auth.uid(), now())
  on conflict (post_id, which) do update
  set before = excluded.before, after = excluded.after, brand_id = excluded.brand_id,
      edited_by = coalesce(excluded.edited_by, public.social_post_edits.edited_by),
      edited_at = now()
  where public.social_post_edits.after is distinct from excluded.after
     or public.social_post_edits.before is distinct from excluded.before;
end;
$$;
revoke all on function private.note_social_caption_edit(public.social_posts, text, text) from public;

create function private.social_post_edits_note()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_key text;
  v_value text;
begin
  if new.ai_draft is null then
    return null;
  end if;
  if tg_op = 'UPDATE' and new.caption is not distinct from old.caption
     and new.captions is not distinct from old.captions
     and new.ai_draft is not distinct from old.ai_draft
     and new.brand_id is not distinct from old.brand_id then
    return null;
  end if;
  perform private.note_social_caption_edit(new, 'main', new.caption);
  -- An account's own caption: only those keyed by an account id.
  for v_key, v_value in
    select k, v from jsonb_each_text(coalesce(new.captions, '{}'::jsonb)) as c(k, v)
    where k ~ '^[0-9a-f-]{36}$'
  loop
    perform private.note_social_caption_edit(new, v_key, v_value);
  end loop;
  delete from public.social_post_edits e
  where e.post_id = new.id and e.which <> 'main'
    and not (coalesce(new.captions, '{}'::jsonb) ? e.which);
  return null;
end;
$$;
revoke all on function private.social_post_edits_note() from public;
create trigger social_posts_note_edits
  after insert or update on public.social_posts
  for each row execute function private.social_post_edits_note();

-- Posts saved before this: what already differs from Claude's draft is kept,
-- so the first suggestion has something to read. No one is named.
insert into public.social_post_edits (tenant_id, brand_id, post_id, which, before, after, edited_at)
select p.tenant_id, p.brand_id, p.id, 'main',
       left(btrim(p.ai_draft), 2200), left(btrim(p.caption), 2200), p.updated_at
from public.social_posts p
where btrim(coalesce(p.ai_draft, '')) <> '' and btrim(p.caption) <> ''
  and btrim(p.caption) <> btrim(p.ai_draft)
on conflict (post_id, which) do nothing;
