-- Emailing a purchase order to the supplier from the business's own Gmail.
--
-- The mailbox is a connection like any other (provider `google_mail`): the
-- permission to send lives in Vault and is read only through
-- getProviderToken. Nothing here holds a token.
--
-- This table is the record on the order of each time it was emailed: when,
-- who pressed, to whom, and Gmail's own id for the message. It is also what
-- makes a send happen once: a send is claimed here under a request key
-- before Gmail is asked, so a second press finds the first.
--
-- `snapshot` is what the order said when it went (the parts a supplier sees:
-- lines, costs, shipping, dates, notes) and `fingerprint` a short digest of
-- it. Whether the order has "changed since it was sent" is worked out on read
-- by comparing fingerprints; nothing derived is stored.

alter table public.connections drop constraint connections_provider_check;
alter table public.connections add constraint connections_provider_check
  check (provider in ('shopify', 'quickbooks', 'meta', 'google', 'stripe', 'easypost', 'ups',
                      'redo', 'google_mail'));

create table public.purchase_order_emails (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  po_id uuid not null references public.purchase_orders (id) on delete cascade,
  -- The key the page made for that press of "Send".
  request_key uuid not null,
  -- sending: Gmail is being asked. sent: Gmail took it. failed: Gmail said no
  -- (nothing went; the same press may be tried again). unsure: we never heard
  -- back, so it may or may not have gone; it is never sent again by itself.
  status text not null default 'sending'
    check (status in ('sending', 'sent', 'failed', 'unsure')),
  to_emails text[] not null check (cardinality(to_emails) between 1 and 10),
  cc_emails text[] not null default '{}' check (cardinality(cc_emails) <= 5),
  subject text not null check (char_length(subject) between 1 and 300),
  -- The mailbox it went from, and who pressed.
  sender_email text not null check (char_length(sender_email) <= 200),
  sent_by uuid references auth.users (id) on delete set null,
  -- Gmail's ids for the message and its conversation, and our own Message-ID
  -- header, which a later send replies to so both land in one thread.
  gmail_message_id text check (gmail_message_id is null or char_length(gmail_message_id) <= 200),
  gmail_thread_id text check (gmail_thread_id is null or char_length(gmail_thread_id) <= 200),
  message_id_header text not null check (char_length(message_id_header) <= 300),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  fingerprint text not null check (char_length(fingerprint) <= 64),
  error text check (error is null or char_length(error) <= 300),
  attempts int not null default 1 check (attempts >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (tenant_id, request_key)
);
create index purchase_order_emails_po_idx
  on public.purchase_order_emails (tenant_id, po_id, created_at desc);

alter table public.purchase_order_emails enable row level security;
create policy "members read their purchase_order_emails" on public.purchase_order_emails
  for select to authenticated
  using (tenant_id in (select private.user_tenant_ids()));
revoke all on public.purchase_order_emails from public, anon, authenticated, service_role;
grant select on public.purchase_order_emails to authenticated, service_role;

-- Tidy, lower-case addresses, each once, in the order given. Raises on one
-- that isn't an address.
create function private.tidy_emails(p_emails text[])
returns text[]
language plpgsql immutable set search_path = ''
as $$
declare
  v_out text[] := '{}';
  v_email text;
begin
  foreach v_email in array coalesce(p_emails, '{}')
  loop
    v_email := lower(btrim(coalesce(v_email, '')));
    continue when v_email = '' or v_email = any (v_out);
    if char_length(v_email) > 200
       or v_email !~ '^[^[:space:]@<>",;]+@[^[:space:]@<>",;]+\.[^[:space:]@<>",;]+$' then
      raise exception 'Bad email' using errcode = '22023';
    end if;
    v_out := v_out || v_email;
  end loop;
  return v_out;
end;
$$;
revoke all on function private.tidy_emails(text[]) from public;

-- Claims a send before Gmail is asked. Owners and admins only.
-- Returns what to do with this press:
--   new     go ahead and send
--   retry   this press failed cleanly before (Gmail said no): go ahead again
--   sent    this press already went: say so, send nothing
--   busy    this press is being sent right now: send nothing
--   unsure  an earlier try of this press never reported back, so it may have
--           gone: send nothing; the person checks their Sent folder
-- With it come the conversation to reply into, when this mailbox has emailed
-- this order before.
create function public.begin_po_email(
  p_po_id uuid, p_request_key uuid, p_to text[], p_cc text[], p_subject text,
  p_sender_email text, p_message_id text, p_snapshot jsonb, p_fingerprint text
)
returns table (id uuid, state text, thread_id text, reply_to text)
language plpgsql security definer set search_path = ''
as $$
declare
  v_po public.purchase_orders := private.manager_po(p_po_id);
  v_to text[] := private.tidy_emails(p_to);
  v_cc text[] := private.tidy_emails(p_cc);
  v_subject text := btrim(regexp_replace(coalesce(p_subject, ''), '[[:cntrl:]]+', ' ', 'g'));
  v_sender text := lower(btrim(coalesce(p_sender_email, '')));
  v_row public.purchase_order_emails;
  v_state text;
  v_thread text;
  v_reply text;
begin
  if p_request_key is null then
    raise exception 'A request key is needed' using errcode = '22023';
  end if;
  if v_po.status = 'cancelled' then
    raise exception 'order_cancelled' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.purchase_order_lines l where l.po_id = v_po.id and l.qty_ordered > 0
  ) then
    raise exception 'order_empty' using errcode = 'P0001';
  end if;
  -- Nobody is copied who is already written to.
  select coalesce(array_agg(c order by ord), '{}') into v_cc
  from unnest(v_cc) with ordinality as x(c, ord) where c <> all (v_to);
  if cardinality(v_to) not between 1 and 10 or cardinality(v_cc) > 5
     or char_length(v_subject) not between 1 and 300 or v_sender = ''
     or coalesce(p_message_id, '') !~ '^<[^<>[:space:]]+>$'
     or char_length(p_message_id) not between 5 and 300
     or jsonb_typeof(coalesce(p_snapshot, 'null'::jsonb)) <> 'object'
     or coalesce(p_fingerprint, '') !~ '^[0-9a-f]{8,64}$' then
    raise exception 'That email can''t be sent as it is' using errcode = '22023';
  end if;

  select * into v_row from public.purchase_order_emails e
  where e.tenant_id = v_po.tenant_id and e.request_key = p_request_key
  for update;
  if found then
    if v_row.po_id <> v_po.id then
      raise exception 'A request key is needed' using errcode = '22023';
    end if;
    if v_row.status = 'sent' then
      v_state := 'sent';
    elsif v_row.status = 'unsure' then
      v_state := 'unsure';
    elsif v_row.status = 'sending' then
      if v_row.updated_at > now() - interval '2 minutes' then
        v_state := 'busy';
      else
        -- Claimed and never finished: we can't say whether it went.
        update public.purchase_order_emails e
        set status = 'unsure', updated_at = now(),
            error = 'We never heard back from Gmail, so we can''t tell whether this one went'
        where e.id = v_row.id;
        v_state := 'unsure';
      end if;
    else
      -- Failed cleanly: the same press may go again, as it is now.
      update public.purchase_order_emails e
      set status = 'sending', attempts = e.attempts + 1, updated_at = now(), error = null,
          to_emails = v_to, cc_emails = v_cc, subject = v_subject, sender_email = v_sender,
          message_id_header = p_message_id, snapshot = p_snapshot, fingerprint = p_fingerprint,
          sent_by = auth.uid()
      where e.id = v_row.id;
      v_state := 'retry';
    end if;
  else
    insert into public.purchase_order_emails
      (tenant_id, po_id, request_key, to_emails, cc_emails, subject, sender_email, sent_by,
       message_id_header, snapshot, fingerprint)
    values (v_po.tenant_id, v_po.id, p_request_key, v_to, v_cc, v_subject, v_sender, auth.uid(),
            p_message_id, p_snapshot, p_fingerprint)
    returning * into v_row;
    v_state := 'new';
  end if;

  -- The conversation this mailbox already has about this order, if any.
  select e.gmail_thread_id, e.message_id_header into v_thread, v_reply
  from public.purchase_order_emails e
  where e.po_id = v_po.id and e.status = 'sent' and e.gmail_thread_id is not null
    and e.sender_email = v_sender and e.id <> v_row.id
  order by e.sent_at desc limit 1;

  return query select v_row.id, v_state, v_thread, v_reply;
end;
$$;

-- Records how a send went. 'sent' also does what TuftStock does when an order
-- is emailed: a draft becomes "ordered", and a supplier with no email saved
-- keeps the addresses it was sent to. Returns true when the order was marked
-- as ordered by this.
create function public.finish_po_email(
  p_email_id uuid, p_outcome text, p_gmail_message_id text default null,
  p_gmail_thread_id text default null, p_error text default null
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_email public.purchase_order_emails;
  v_po public.purchase_orders;
  v_marked boolean := false;
begin
  select * into v_email from public.purchase_order_emails e
  where e.id = p_email_id and e.tenant_id in (select private.user_tenant_ids());
  if not found then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;
  v_po := private.manager_po(v_email.po_id);
  if p_outcome not in ('sent', 'failed', 'unsure') then
    raise exception 'Unknown outcome' using errcode = '22023';
  end if;

  update public.purchase_order_emails e
  set status = p_outcome, updated_at = now(),
      sent_at = case when p_outcome = 'sent' then now() end,
      gmail_message_id = case when p_outcome = 'sent' then left(p_gmail_message_id, 200) end,
      gmail_thread_id = case when p_outcome = 'sent' then left(p_gmail_thread_id, 200) end,
      error = case when p_outcome = 'sent' then null
        else left(coalesce(nullif(btrim(p_error), ''), 'It didn''t send'), 300) end
  where e.id = v_email.id and e.status = 'sending';
  if not found or p_outcome <> 'sent' then
    return false;
  end if;

  if v_po.status = 'draft' then
    update public.purchase_orders po set status = 'ordered', ordered_at = now()
    where po.id = v_po.id;
    v_marked := true;
  end if;
  -- First time this supplier is emailed: remember who it went to.
  update public.suppliers s
  set email = v_email.to_emails[1],
      more_emails = coalesce((v_email.to_emails)[2:6], '{}')
  where s.id = v_po.supplier_id and s.email is null and cardinality(s.more_emails) = 0;
  return v_marked;
end;
$$;

revoke all on function public.begin_po_email(uuid, uuid, text[], text[], text, text, text, jsonb, text)
  from public, anon;
grant execute on function public.begin_po_email(uuid, uuid, text[], text[], text, text, text, jsonb, text)
  to authenticated;
revoke all on function public.finish_po_email(uuid, text, text, text, text) from public, anon;
grant execute on function public.finish_po_email(uuid, text, text, text, text) to authenticated;
