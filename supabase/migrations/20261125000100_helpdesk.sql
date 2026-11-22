-- Phase 5: help desk.
-- contacts, tickets, messages and tags, plus a private queue of inbound
-- emails. Members read; every write goes through a function that checks who
-- is asking. Reply templates and auto-tag rules live in `configs`.

create type public.ticket_status as enum ('open', 'pending', 'closed');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  email text not null check (email = lower(email)),
  name text,
  created_at timestamptz not null default now(),
  unique (tenant_id, email)
);

create table public.tickets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  -- Counts up per workspace: #1, #2, ...
  number int not null,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  subject text not null,
  -- open: needs a reply. pending: we replied, waiting on the customer.
  status public.ticket_status not null default 'open',
  -- Unguessable part of the reply-to address that routes replies back here.
  reply_key text not null unique,
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, number)
);
create index tickets_tenant_status_idx on public.tickets (tenant_id, status, last_message_at desc);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  ticket_id uuid not null references public.tickets (id) on delete cascade,
  direction text not null check (direction in ('inbound', 'outbound')),
  from_email text not null,
  from_name text,
  body text not null,
  -- The email's own Message-ID header, for threading.
  message_id text,
  -- The mail provider's id for this delivery; an email is stored once.
  provider_message_id text,
  -- The teammate who sent an outbound message.
  author_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (tenant_id, provider_message_id)
);
create index messages_ticket_idx on public.messages (ticket_id, created_at);
create index messages_tenant_message_id_idx on public.messages (tenant_id, message_id);

create table public.tags (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null check (name = lower(name) and name ~ '^[a-z0-9][a-z0-9 _-]{0,29}$'),
  created_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table public.ticket_tags (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  ticket_id uuid not null references public.tickets (id) on delete cascade,
  tag_id uuid not null references public.tags (id) on delete cascade,
  primary key (ticket_id, tag_id)
);

-- Verified inbound emails waiting for the worker. Not tenant data yet: the
-- workspace is worked out from the address when the email is processed.
create table private.inbound_emails (
  id text primary key,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  locked_at timestamptz,
  processed_at timestamptz,
  attempts int not null default 0,
  last_error text
);
create index inbound_emails_pending_idx on private.inbound_emails (received_at) where processed_at is null;

-- ---------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['contacts', 'tickets', 'messages', 'tags', 'ticket_tags']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy "members read their %s" on public.%I for select to authenticated
         using (tenant_id in (select private.user_tenant_ids()))', t, t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on public.%I to service_role', t);
  end loop;
end;
$$;

grant select on public.contacts, public.messages, public.tags, public.ticket_tags to authenticated;
-- reply_key stays server-side: it is what lets an email into a ticket.
grant select (id, tenant_id, number, contact_id, subject, status, last_message_at, created_at, updated_at)
  on public.tickets to authenticated;

alter table private.inbound_emails enable row level security;
revoke all on private.inbound_emails from public, anon, authenticated, service_role;

create trigger tickets_touch_updated_at
  before update on public.tickets
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Tags (shared by the worker and by members)
-- ---------------------------------------------------------------------------

create function private.add_ticket_tags(p_tenant_id uuid, p_ticket_id uuid, p_tags text[])
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_name text;
  v_tag_id uuid;
begin
  foreach v_name in array coalesce(p_tags, '{}')
  loop
    v_name := lower(btrim(v_name));
    continue when v_name !~ '^[a-z0-9][a-z0-9 _-]{0,29}$';
    insert into public.tags (tenant_id, name) values (p_tenant_id, v_name)
    on conflict (tenant_id, name) do update set name = excluded.name
    returning id into v_tag_id;
    insert into public.ticket_tags (tenant_id, ticket_id, tag_id)
    values (p_tenant_id, p_ticket_id, v_tag_id)
    on conflict do nothing;
  end loop;
end;
$$;
revoke all on function private.add_ticket_tags(uuid, uuid, text[]) from public;

-- ---------------------------------------------------------------------------
-- Inbound email (service role only)
-- ---------------------------------------------------------------------------

create function public.enqueue_inbound_email(p_id text, p_payload jsonb)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_inserted int;
begin
  insert into private.inbound_emails (id, payload) values (p_id, p_payload)
  on conflict (id) do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted = 1;
end;
$$;

create function public.claim_inbound_emails(p_limit int default 10)
returns table (id text, payload jsonb, attempts int)
language sql security definer set search_path = ''
as $$
  update private.inbound_emails e
  set locked_at = now(), attempts = e.attempts + 1
  where e.id in (
    select s.id from private.inbound_emails s
    where s.processed_at is null
      and s.attempts < 8
      and (s.locked_at is null or s.locked_at < now() - interval '5 minutes')
    order by s.received_at
    limit greatest(1, least(coalesce(p_limit, 10), 100))
    for update skip locked
  )
  returning e.id, e.payload, e.attempts;
$$;

-- Finished emails drop their payload: the message itself is now in a ticket.
create function public.complete_inbound_email(p_id text, p_error text default null)
returns void
language sql security definer set search_path = ''
as $$
  update private.inbound_emails e
  set processed_at = case when p_error is null then now() else null end,
      locked_at = case when p_error is null then null else e.locked_at end,
      payload = case when p_error is null then '{}'::jsonb else e.payload end,
      last_error = p_error
  where e.id = p_id;
$$;

-- Files one email into the right workspace and ticket. Returns what happened:
--   {"result": "unknown_workspace" | "duplicate" | "created" | "threaded", ...}
-- Threading, in order: the reply key from the address, then the email's own
-- In-Reply-To / References headers, otherwise a new ticket.
create function public.ingest_inbound_email(
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
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_email text := lower(btrim(coalesce(p_from_email, '')));
  v_contact_id uuid;
  v_ticket public.tickets;
  v_created boolean := false;
begin
  -- Locking the workspace row keeps ticket numbers gap-free and in order.
  select t.id into v_tenant_id from public.tenants t where t.slug = p_slug for update;
  if v_tenant_id is null then
    return jsonb_build_object('result', 'unknown_workspace');
  end if;
  if v_email = '' then
    raise exception 'Inbound email has no sender';
  end if;
  if exists (
    select 1 from public.messages m
    where m.tenant_id = v_tenant_id and m.provider_message_id = p_provider_message_id
  ) then
    return jsonb_build_object('result', 'duplicate');
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
    -- A customer writing back reopens the conversation.
    update public.tickets t set status = 'open', last_message_at = now() where t.id = v_ticket.id;
  end if;

  insert into public.messages
    (tenant_id, ticket_id, direction, from_email, from_name, body, message_id, provider_message_id)
  values
    (v_tenant_id, v_ticket.id, 'inbound', v_email, nullif(btrim(coalesce(p_from_name, '')), ''),
     coalesce(p_body, ''), p_message_id, p_provider_message_id);

  perform private.add_ticket_tags(v_tenant_id, v_ticket.id, p_tags);

  return jsonb_build_object(
    'result', case when v_created then 'created' else 'threaded' end,
    'tenant_id', v_tenant_id,
    'ticket_id', v_ticket.id,
    'number', v_ticket.number
  );
end;
$$;

-- The reply-to key and newest inbound Message-ID for a ticket, for the app
-- server to address a reply. Service role only.
create function public.ticket_reply_context(p_tenant_id uuid, p_ticket_id uuid)
returns table (reply_key text, subject text, contact_email text, contact_name text, last_message_id text)
language sql stable security definer set search_path = ''
as $$
  select t.reply_key, t.subject, c.email, c.name,
         (select m.message_id from public.messages m
          where m.ticket_id = t.id and m.direction = 'inbound' and m.message_id is not null
          order by m.created_at desc limit 1)
  from public.tickets t
  join public.contacts c on c.id = t.contact_id
  where t.id = p_ticket_id and t.tenant_id = p_tenant_id;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.enqueue_inbound_email(text, jsonb)',
    'public.claim_inbound_emails(int)',
    'public.complete_inbound_email(text, text)',
    'public.ingest_inbound_email(text, text, text, text, text, text, text, text, text[], text[])',
    'public.ticket_reply_context(uuid, uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- What members do (each checks membership itself)
-- ---------------------------------------------------------------------------

create function private.member_ticket(p_ticket_id uuid)
returns public.tickets
language plpgsql security definer set search_path = ''
as $$
declare
  v_ticket public.tickets;
begin
  select * into v_ticket from public.tickets t
  where t.id = p_ticket_id and t.tenant_id in (select private.user_tenant_ids())
  for update;
  if not found then
    raise exception 'Ticket not found' using errcode = 'P0002';
  end if;
  return v_ticket;
end;
$$;
revoke all on function private.member_ticket(uuid) from public;

-- Records a reply a teammate sent. The app sends the email first and passes
-- the provider's id, so a retried request can't store the reply twice.
create function public.record_reply(
  p_ticket_id uuid,
  p_body text,
  p_from_email text,
  p_provider_message_id text,
  p_message_id text default null
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_ticket public.tickets := private.member_ticket(p_ticket_id);
  v_id uuid;
begin
  if btrim(coalesce(p_body, '')) = '' then
    raise exception 'A reply needs some words in it' using errcode = '22023';
  end if;
  insert into public.messages
    (tenant_id, ticket_id, direction, from_email, body, message_id, provider_message_id, author_id)
  values
    (v_ticket.tenant_id, v_ticket.id, 'outbound', lower(p_from_email), p_body, p_message_id,
     p_provider_message_id, auth.uid())
  on conflict (tenant_id, provider_message_id) do nothing
  returning id into v_id;

  update public.tickets t set status = 'pending', last_message_at = now() where t.id = v_ticket.id;
  return v_id;
end;
$$;

create function public.set_ticket_status(p_ticket_id uuid, p_status public.ticket_status)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_ticket public.tickets := private.member_ticket(p_ticket_id);
begin
  update public.tickets t set status = p_status where t.id = v_ticket.id;
end;
$$;

-- Replaces a ticket's tags with the list given, creating tags as needed.
create function public.set_ticket_tags(p_ticket_id uuid, p_tags text[])
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_ticket public.tickets := private.member_ticket(p_ticket_id);
begin
  delete from public.ticket_tags tt where tt.ticket_id = v_ticket.id;
  perform private.add_ticket_tags(v_ticket.tenant_id, v_ticket.id, p_tags);
end;
$$;

-- Owners and admins pick which optional tools their plan's choice covers.
-- The app checks the list against the plan before calling this.
create function public.choose_modules(p_tenant_id uuid, p_modules text[])
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.has_tenant_role(p_tenant_id, array['owner', 'admin']::public.membership_role[]) then
    raise exception 'Only owners and admins can change this' using errcode = '42501';
  end if;
  if not coalesce(p_modules, '{}') <@ array['helpdesk', 'bookings', 'social'] then
    raise exception 'That tool is not one you can choose' using errcode = '22023';
  end if;
  update public.subscriptions s set selected_modules = coalesce(p_modules, '{}')
  where s.tenant_id = p_tenant_id;
  perform private.log_audit(p_tenant_id, 'plan.modules_chosen', 'subscription', p_tenant_id::text,
    jsonb_build_object('modules', p_modules));
end;
$$;

revoke all on function public.record_reply(uuid, text, text, text, text) from public, anon;
revoke all on function public.set_ticket_status(uuid, public.ticket_status) from public, anon;
revoke all on function public.set_ticket_tags(uuid, text[]) from public, anon;
revoke all on function public.choose_modules(uuid, text[]) from public, anon;
grant execute on function public.record_reply(uuid, text, text, text, text) to authenticated;
grant execute on function public.set_ticket_status(uuid, public.ticket_status) to authenticated;
grant execute on function public.set_ticket_tags(uuid, text[]) to authenticated;
grant execute on function public.choose_modules(uuid, text[]) to authenticated;

-- Erasing a shopper (a Shopify privacy request) now also removes their help
-- desk contact, and with it their tickets and messages.
create or replace function public.redact_customer(
  p_tenant_id uuid,
  p_provider text,
  p_customer_external_id text,
  p_email text default null
)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_orders int;
  v_email text;
begin
  select coalesce(lower(p_email), c.email) into v_email from public.customers c
  where c.tenant_id = p_tenant_id and c.provider = p_provider and c.external_id = p_customer_external_id;
  v_email := coalesce(v_email, lower(p_email));

  delete from public.customers c
  where c.tenant_id = p_tenant_id and c.provider = p_provider
    and (c.external_id = p_customer_external_id or (v_email is not null and c.email = v_email));

  update public.orders o
  set customer_external_id = null, email = null
  where o.tenant_id = p_tenant_id and o.provider = p_provider
    and (o.customer_external_id = p_customer_external_id or (v_email is not null and o.email = v_email));
  get diagnostics v_orders = row_count;

  if v_email is not null then
    delete from public.contacts c where c.tenant_id = p_tenant_id and c.email = v_email;
  end if;

  insert into public.audit_log (tenant_id, action, target_type, target_id, metadata)
  values (p_tenant_id, 'privacy.customer_redacted', 'customer', p_customer_external_id,
          jsonb_build_object('provider', p_provider, 'orders_anonymised', v_orders));
  return v_orders;
end;
$$;
