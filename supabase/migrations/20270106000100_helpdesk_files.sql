-- Help desk, fourth pass: the pictures and files that come with an email.
-- Until now only an email's words were kept. Files now go into a private
-- storage bucket and are listed here; they are written only by the server
-- (the worker for incoming mail, the app for what the team sends), read by
-- members of the workspace, and handed to a browser only through a route
-- that checks who is asking. Who else an incoming email was written to is
-- kept too, so "Reply all" can include them.

-- ---------------------------------------------------------------------------
-- The bucket: private. Paths are <workspace>/<ticket>/<message>/<random id>,
-- never a name anyone typed.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('helpdesk', 'helpdesk', false, 26214400,
        array['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic',
              'application/pdf', 'video/mp4', 'video/quicktime', 'text/plain', 'text/csv'])
on conflict (id) do nothing;

-- No client ever reads or writes this bucket directly, whatever other policy
-- storage may carry now or later. The server uses the service role.
create policy "help desk files are served by the app only" on storage.objects
  as restrictive for all to anon, authenticated
  using (bucket_id <> 'helpdesk')
  with check (bucket_id <> 'helpdesk');

-- ---------------------------------------------------------------------------
-- What came with each message
-- ---------------------------------------------------------------------------

create table public.message_attachments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  message_id uuid not null references public.messages (id) on delete cascade,
  -- For people to read. Tidied by the server; never part of a path.
  name text not null check (char_length(name) between 1 and 120),
  -- For a kept file: what its own bytes say it is. Otherwise what the sender claimed.
  mime_type text not null check (char_length(mime_type) between 1 and 110),
  bytes bigint not null check (bytes >= 0),
  -- Null for a file we didn't keep.
  storage_path text unique,
  -- The id a picture set into the email is referred to by.
  content_id text check (content_id is null or char_length(content_id) <= 200),
  state text not null check (state in ('kept', 'not_kept')),
  reason text check (reason is null or reason in ('type', 'too_big', 'message_cap', 'daily_cap', 'failed')),
  created_at timestamptz not null default now(),
  check ((state = 'kept') = (storage_path is not null)),
  check (state <> 'kept' or mime_type in
    ('image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic',
     'application/pdf', 'video/mp4', 'video/quicktime', 'text/plain', 'text/csv')),
  check (storage_path is null or storage_path like tenant_id::text || '/%')
);
create index message_attachments_message_idx on public.message_attachments (message_id);
create index message_attachments_tenant_day_idx on public.message_attachments (tenant_id, created_at)
  where state = 'kept';

alter table public.message_attachments enable row level security;
revoke all on public.message_attachments from public, anon, authenticated, service_role;
grant select on public.message_attachments to authenticated, service_role;
-- The same people who can read the conversation.
create policy "members read their message attachments" on public.message_attachments
  for select to authenticated using (tenant_id in (select private.user_tenant_ids()));

-- Files to take out of storage. A row lands here whenever an attachment row
-- goes, however it goes: a conversation deleted for good, a customer
-- forgotten, a workspace removed. The worker empties it.
create table private.attachment_removals (
  storage_path text primary key,
  queued_at timestamptz not null default now(),
  locked_at timestamptz
);
alter table private.attachment_removals enable row level security;
revoke all on private.attachment_removals from public, anon, authenticated, service_role;

create function private.queue_attachment_removal()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.storage_path is not null then
    insert into private.attachment_removals (storage_path) values (old.storage_path)
    on conflict (storage_path) do nothing;
  end if;
  return old;
end;
$$;
revoke all on function private.queue_attachment_removal() from public;
create trigger message_attachments_queue_removal
  before delete on public.message_attachments
  for each row execute function private.queue_attachment_removal();

-- ---------------------------------------------------------------------------
-- Written by the server only (service role), always naming the workspace
-- ---------------------------------------------------------------------------

-- How much this workspace has kept in the last day, for the daily allowance.
create function public.attachment_bytes_today(p_tenant_id uuid)
returns bigint
language sql stable security definer set search_path = ''
as $$
  select coalesce(sum(a.bytes), 0)::bigint from public.message_attachments a
  where a.tenant_id = p_tenant_id and a.state = 'kept' and a.created_at > now() - interval '24 hours';
$$;

-- Lists a message's files: [{name, type, size, path, content_id, state, reason}].
-- Once per message: a second call changes nothing and returns 0, so a retried
-- email can't list its files twice. Returns how many rows were written.
create function public.record_message_attachments(p_tenant_id uuid, p_message_id uuid, p_files jsonb)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  perform 1 from public.messages m
  where m.id = p_message_id and m.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'Message not found' using errcode = 'P0002';
  end if;
  if jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) > 30 then
    raise exception 'Too many files for one message' using errcode = '22023';
  end if;
  if exists (select 1 from public.message_attachments a where a.message_id = p_message_id) then
    return 0;
  end if;
  insert into public.message_attachments
    (tenant_id, message_id, name, mime_type, bytes, storage_path, content_id, state, reason)
  select p_tenant_id, p_message_id,
         left(coalesce(nullif(btrim(f ->> 'name'), ''), 'file'), 120),
         left(coalesce(nullif(btrim(f ->> 'type'), ''), 'unknown'), 110),
         greatest(coalesce((f ->> 'size')::bigint, 0), 0),
         case when f ->> 'state' = 'kept' then f ->> 'path' end,
         nullif(left(coalesce(f ->> 'content_id', ''), 200), ''),
         case when f ->> 'state' = 'kept' then 'kept' else 'not_kept' end,
         case when f ->> 'state' = 'kept' then null else coalesce(f ->> 'reason', 'type') end
  from jsonb_array_elements(p_files) as f;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create function public.claim_attachment_removals(p_limit int default 100)
returns setof text
language sql security definer set search_path = ''
as $$
  update private.attachment_removals r
  set locked_at = now()
  where r.storage_path in (
    select s.storage_path from private.attachment_removals s
    where s.locked_at is null or s.locked_at < now() - interval '10 minutes'
    order by s.queued_at
    limit greatest(1, least(coalesce(p_limit, 100), 500))
    for update skip locked
  )
  returning r.storage_path;
$$;

create function public.finish_attachment_removals(p_paths text[])
returns void
language sql security definer set search_path = ''
as $$
  delete from private.attachment_removals r where r.storage_path = any (p_paths);
$$;

-- ---------------------------------------------------------------------------
-- Incoming email, now with who else it went to. The older function keeps its
-- name and signature and hands over to this one.
-- Returns {"result", "tenant_id", "ticket_id", "message_id", "number"}; an
-- email seen before answers "duplicate" with the message it became, so a
-- retry can finish keeping its files.
-- ---------------------------------------------------------------------------

create function public.file_inbound_email(
  p_slug text,
  p_provider_message_id text,
  p_from_email text,
  p_from_name text,
  p_subject text,
  p_body text,
  p_message_id text default null,
  p_reply_key text default null,
  p_references text[] default '{}',
  p_tags text[] default '{}',
  p_to text[] default '{}',
  p_cc text[] default '{}'
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_email text := lower(btrim(coalesce(p_from_email, '')));
  v_contact_id uuid;
  v_ticket public.tickets;
  v_created boolean := false;
  v_message public.messages;
begin
  -- Locking the workspace row keeps ticket numbers gap-free and in order.
  select t.id into v_tenant_id from public.tenants t where t.slug = p_slug for update;
  if v_tenant_id is null then
    return jsonb_build_object('result', 'unknown_workspace');
  end if;
  if v_email = '' then
    raise exception 'Inbound email has no sender';
  end if;
  select * into v_message from public.messages m
  where m.tenant_id = v_tenant_id and m.provider_message_id = p_provider_message_id;
  if v_message.id is not null then
    return jsonb_build_object('result', 'duplicate', 'tenant_id', v_tenant_id,
                              'ticket_id', v_message.ticket_id, 'message_id', v_message.id);
  end if;

  insert into public.contacts (tenant_id, email, name)
  values (v_tenant_id, v_email, nullif(btrim(coalesce(p_from_name, '')), ''))
  on conflict (tenant_id, email) do update
    set name = coalesce(public.contacts.name, excluded.name)
  returning id into v_contact_id;

  if p_reply_key is not null then
    select * into v_ticket from public.tickets t
    where t.tenant_id = v_tenant_id and t.reply_key = p_reply_key;
  end if;
  if v_ticket.id is null and coalesce(array_length(p_references, 1), 0) > 0 then
    select t.* into v_ticket
    from public.messages m
    join public.tickets t on t.id = m.ticket_id
    where m.tenant_id = v_tenant_id and m.message_id = any (p_references)
    order by m.created_at desc
    limit 1;
  end if;
  -- Follow a folded conversation to where it went (a few hops at most).
  for i in 1 .. 5 loop
    exit when v_ticket.id is null or v_ticket.merged_into is null;
    select * into v_ticket from public.tickets t
    where t.id = v_ticket.merged_into and t.tenant_id = v_tenant_id;
  end loop;

  if v_ticket.id is null then
    insert into public.tickets (tenant_id, number, contact_id, subject, reply_key)
    values (
      v_tenant_id,
      (select coalesce(max(t.number), 0) + 1 from public.tickets t where t.tenant_id = v_tenant_id),
      v_contact_id,
      left(coalesce(nullif(btrim(p_subject), ''), '(no subject)'), 200),
      replace(gen_random_uuid()::text, '-', '')
    )
    returning * into v_ticket;
    v_created := true;
  else
    -- A customer writing back reopens the conversation and wakes it.
    update public.tickets t
    set status = 'open', last_message_at = now(), snoozed_until = null, closed_at = null
    where t.id = v_ticket.id;
  end if;

  insert into public.messages
    (tenant_id, ticket_id, direction, from_email, from_name, body, message_id, provider_message_id,
     to_emails, cc_emails)
  values
    (v_tenant_id, v_ticket.id, 'inbound', v_email, nullif(btrim(coalesce(p_from_name, '')), ''),
     coalesce(p_body, ''), p_message_id, p_provider_message_id,
     coalesce((select array_agg(lower(btrim(e))) from unnest(p_to[1:10]) as e where btrim(e) <> ''), '{}'),
     coalesce((select array_agg(lower(btrim(e))) from unnest(p_cc[1:10]) as e where btrim(e) <> ''), '{}'))
  returning * into v_message;

  perform private.add_ticket_tags(v_tenant_id, v_ticket.id, p_tags);

  return jsonb_build_object(
    'result', case when v_created then 'created' else 'threaded' end,
    'tenant_id', v_tenant_id,
    'ticket_id', v_ticket.id,
    'message_id', v_message.id,
    'number', v_ticket.number
  );
end;
$$;

create or replace function public.ingest_inbound_email(
  p_slug text,
  p_provider_message_id text,
  p_from_email text,
  p_from_name text,
  p_subject text,
  p_body text,
  p_message_id text default null,
  p_reply_key text default null,
  p_references text[] default '{}',
  p_tags text[] default '{}'
)
returns jsonb
language sql security definer set search_path = ''
as $$
  select public.file_inbound_email(p_slug, p_provider_message_id, p_from_email, p_from_name,
    p_subject, p_body, p_message_id, p_reply_key, p_references, p_tags, '{}', '{}');
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.attachment_bytes_today(uuid)',
    'public.record_message_attachments(uuid, uuid, jsonb)',
    'public.claim_attachment_removals(int)',
    'public.finish_attachment_removals(text[])',
    'public.file_inbound_email(text, text, text, text, text, text, text, text, text[], text[], text[], text[])'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
