-- Marketing emails designed in the builder. An email is a document (blocks,
-- styles, subject) kept as JSON; the app turns it into HTML for the person
-- to copy into whatever they send email with. Nothing is sent from here.

create table public.emails (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  -- Shown in the list; taken from the document when it is saved.
  title text not null default 'Untitled email' check (char_length(title) <= 160),
  doc jsonb not null check (jsonb_typeof(doc) = 'object' and pg_column_size(doc) <= 1048576),
  -- What the person asked Claude for, when it was drafted that way.
  prompt text not null default '' check (char_length(prompt) <= 2000),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index emails_tenant_idx on public.emails (tenant_id, updated_at desc);
alter table public.emails enable row level security;
create policy "members read their emails" on public.emails
  for select to authenticated using (tenant_id in (select private.user_tenant_ids()));
revoke all on public.emails from public, anon, authenticated, service_role;
grant select on public.emails to authenticated, service_role;

-- Saves a new email, or the latest state of one being edited.
create function public.save_email(
  p_tenant_id uuid, p_email_id uuid, p_doc jsonb, p_prompt text default null
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_title text := left(coalesce(
    nullif(btrim(p_doc ->> 'title'), ''),
    nullif(btrim(p_doc #>> '{meta,subject}'), ''),
    'Untitled email'), 160);
begin
  perform private.require_member(p_tenant_id);
  if jsonb_typeof(p_doc) is distinct from 'object' then
    raise exception 'That email is not valid' using errcode = '22023';
  end if;
  if p_email_id is null then
    if (select count(*) from public.emails e where e.tenant_id = p_tenant_id) >= 2000 then
      raise exception 'too_many_emails' using errcode = 'P0001';
    end if;
    insert into public.emails (tenant_id, title, doc, prompt, created_by)
    values (p_tenant_id, v_title, p_doc, left(coalesce(p_prompt, ''), 2000), auth.uid())
    returning id into v_id;
    return v_id;
  end if;
  update public.emails e set doc = p_doc, title = v_title, updated_at = now()
  where e.id = p_email_id and e.tenant_id = p_tenant_id
  returning e.id into v_id;
  if v_id is null then
    raise exception 'Email not found' using errcode = 'P0002';
  end if;
  return v_id;
end;
$$;

create function public.remove_email(p_tenant_id uuid, p_email_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_member(p_tenant_id);
  delete from public.emails e where e.id = p_email_id and e.tenant_id = p_tenant_id;
  if not found then
    raise exception 'Email not found' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.save_email(uuid, uuid, jsonb, text) from public, anon;
grant execute on function public.save_email(uuid, uuid, jsonb, text) to authenticated;
revoke all on function public.remove_email(uuid, uuid) from public, anon;
grant execute on function public.remove_email(uuid, uuid) to authenticated;
