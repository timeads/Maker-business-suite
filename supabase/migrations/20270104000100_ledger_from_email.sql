-- Supplier balances that fill themselves in from email.
--
-- TuftStock reads its suppliers' invoices, statements and the bank's payment
-- notices out of the owner's mail each morning and files them on the vendor
-- ledger. Here the same thing is a general feature: which mail is read is the
-- workspace's own list of sources (configs: stock / email_sources), a reader
-- turns each matching message into a few plain facts, and this migration is
-- where those facts are held against the account and written down.
--
-- A message can arrive three ways: read from the business's Gmail (only with
-- the extra permission to read), forwarded to the workspace's own bills
-- address (next migration), or as a file a manager uploads. All three end in
-- `file_email_entries`, the one function that writes an emailed entry.
--
-- What is kept about a message: its ids, when it was sent, who sent it, its
-- subject, and the facts read from it. Never its text and never a file.
--
-- The rules, after TuftStock's importers:
--   * the same message never files twice (its key), and an invoice whose
--     number is already on the account is not added again;
--   * the supplier's latest statement wins: an invoice or payment dated on or
--     before it is already in its figure and is not filed, and a statement
--     older than the one on file is not filed;
--   * a read there is doubt about is filed marked "to check"
--     (`needs_review`). It counts in the balance from the start, as on
--     TuftStock: the mark asks a person to look, it does not hold the entry
--     back;
--   * anything a manager took off stays off.

-- ---------------------------------------------------------------------------
-- The ledger
-- ---------------------------------------------------------------------------

alter table public.supplier_ledger
  drop constraint supplier_ledger_source_check,
  drop constraint supplier_ledger_books_have_a_key,
  add constraint supplier_ledger_source_check
    check (source in ('manual', 'import', 'books', 'email', 'upload')),
  -- Anything a machine filed carries the key that makes it file once (the
  -- constraint keeps its first name).
  add constraint supplier_ledger_books_have_a_key
    check ((source in ('books', 'email', 'upload')) = (external_key is not null)),
  -- Waiting for a person to look it over. It counts in the balance meanwhile.
  add column needs_review boolean not null default false,
  add column review_note text check (review_note is null or char_length(review_note) <= 500),
  -- Payments read from email: whose word it is. The supplier's own "we
  -- received it" is their record; the bank's notice is ours. The balance
  -- counts a payment seen from both sides once (lib/stock/balance).
  add column reported_by text check (reported_by is null or reported_by in ('supplier', 'bank')),
  -- How an emailed entry reached us, and Gmail's own ids for the message when
  -- it was read there (ids only, for a link that opens it in Gmail).
  add column mail_route text check (mail_route is null or mail_route in ('gmail', 'forward')),
  add column mail_message_id text
    check (mail_message_id is null or mail_message_id ~ '^[0-9a-f]{8,32}$'),
  add column mail_thread_id text
    check (mail_thread_id is null or mail_thread_id ~ '^[0-9a-f]{8,32}$'),
  add constraint supplier_ledger_route_is_for_email
    check (mail_route is null or source = 'email');
create index supplier_ledger_review_idx
  on public.supplier_ledger (tenant_id) where needs_review;

-- "#1007", " 1007 " and "inv 1007" are the same invoice. The app has the same
-- rule (`normalizeInvoiceRef`); a test keeps the two in step.
create function private.ledger_ref_key(p_reference text)
returns text
language sql immutable set search_path = ''
as $$
  select upper(regexp_replace(regexp_replace(regexp_replace(
    btrim(coalesce(p_reference, '')), '^(invoice|inv)\.?(\s+|\s*(?=#))', '', 'i'), '^#\s*', ''),
    '\s+', '', 'g'));
$$;
revoke all on function private.ledger_ref_key(text) from public;

-- ---------------------------------------------------------------------------
-- Looks, messages, and what waits for a supplier
-- ---------------------------------------------------------------------------

-- One look for new mail, or one forwarded message or uploaded file read. The
-- claim that makes a look happen once, and the record of what it found.
create table public.stock_email_reads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'done', 'failed')),
  -- schedule: the day's look at Gmail. manual: a manager pressed "Read now".
  -- forward: a message arrived at the bills address. upload: a file.
  source text not null default 'schedule'
    check (source in ('schedule', 'manual', 'forward', 'upload')),
  requested_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  -- {"seen", "read", "filed", "to_check", "skipped", "capped"}
  counts jsonb not null default '{}'::jsonb check (jsonb_typeof(counts) = 'object'),
  -- What was left out and why: [{"what", "reason"}].
  skipped jsonb not null default '[]'::jsonb
    check (jsonb_typeof(skipped) = 'array' and jsonb_array_length(skipped) <= 60),
  error text check (error is null or char_length(error) <= 500)
);
create unique index stock_email_reads_one_open
  on public.stock_email_reads (tenant_id) where status in ('queued', 'running');
create index stock_email_reads_tenant_idx on public.stock_email_reads (tenant_id, created_at desc);

-- A message that has been looked at, so it is never read twice. Ids, the
-- time, the sender and the subject: not its text, not its files.
create table public.stock_email_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  -- Worked out from the message's own Message-ID, so the same message read
  -- from Gmail and forwarded to the bills address is one message.
  message_key text not null check (message_key ~ '^[0-9a-f]{16,64}$'),
  route text not null check (route in ('gmail', 'forward')),
  gmail_id text check (gmail_id is null or gmail_id ~ '^[0-9a-f]{8,32}$'),
  thread_id text check (thread_id is null or thread_id ~ '^[0-9a-f]{8,32}$'),
  sent_at timestamptz,
  sender text not null default '' check (char_length(sender) <= 200),
  subject text not null default '' check (char_length(subject) <= 300),
  supplier_id uuid references public.suppliers (id) on delete set null,
  -- filed / to_check: something went on an account. unassigned: waiting for a
  -- person to say whose it is. skipped: nothing was filed (see notes).
  outcome text not null check (outcome in ('filed', 'to_check', 'unassigned', 'skipped')),
  notes jsonb not null default '[]'::jsonb
    check (jsonb_typeof(notes) = 'array' and jsonb_array_length(notes) <= 30),
  read_id uuid references public.stock_email_reads (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (tenant_id, message_key)
);
create index stock_email_messages_gmail_idx
  on public.stock_email_messages (tenant_id, gmail_id) where gmail_id is not null;
create index stock_email_messages_recent_idx
  on public.stock_email_messages (tenant_id, created_at desc);

-- What was read from a message nobody could match to a supplier. It waits
-- here for a manager to say whose it is; nothing is guessed.
create table public.stock_email_pending (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  message_key text not null check (message_key ~ '^[0-9a-f]{16,64}$'),
  -- The workspace's calendar day the message was sent.
  sent_day date not null,
  sender text not null default '' check (char_length(sender) <= 200),
  subject text not null default '' check (char_length(subject) <= 300),
  -- The facts read from it, as the reader's checked answer (lib/stock/mail/extract.ts).
  documents jsonb not null
    check (jsonb_typeof(documents) = 'array' and jsonb_array_length(documents) <= 12),
  created_at timestamptz not null default now(),
  unique (tenant_id, message_key)
);

do $$
declare
  t text;
begin
  foreach t in array array['stock_email_reads', 'stock_email_messages', 'stock_email_pending']
  loop
    execute format('alter table public.%I enable row level security', t);
    -- Like the ledger itself: for the people who run the business.
    execute format(
      'create policy "managers read their %s" on public.%I for select to authenticated
         using (private.has_tenant_role(tenant_id, array[''owner'', ''admin'']::public.membership_role[]))',
      t, t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on public.%I to authenticated, service_role', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Is reading Gmail on?
-- ---------------------------------------------------------------------------

-- On only when both are true: the workspace switched "Read supplier emails"
-- on, and its Gmail connection was given the permission to read. A
-- connection that can only send never has its mail looked at.
create function private.email_reading_on(p_tenant_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.connections c
    where c.tenant_id = p_tenant_id and c.provider = 'google_mail' and c.status = 'active'
      and c.scopes @> array['https://www.googleapis.com/auth/gmail.readonly'])
  and exists (
    select 1 from public.configs c
    where c.tenant_id = p_tenant_id and c.module = 'stock' and c.key = 'email_sources'
      and c.body -> 'enabled' = 'true'::jsonb);
$$;
revoke all on function private.email_reading_on(uuid) from public;

-- A manager's "Read now". Pressing it while a look is waiting or underway
-- finds that one. Not more than one every ten minutes or six a day, so a row
-- of presses can't become a row of reads.
create function public.request_stock_email_read(p_tenant_id uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_manager(p_tenant_id);
  if not private.email_reading_on(p_tenant_id) then
    raise exception 'not_on' using errcode = 'P0001';
  end if;
  select r.id into v_id from public.stock_email_reads r
  where r.tenant_id = p_tenant_id and r.status in ('queued', 'running');
  if found then
    return v_id;
  end if;
  if exists (
    select 1 from public.stock_email_reads r
    where r.tenant_id = p_tenant_id and r.source in ('schedule', 'manual')
      and r.created_at > now() - interval '10 minutes'
  ) then
    raise exception 'too_soon' using errcode = 'P0001';
  end if;
  if (select count(*) from public.stock_email_reads r
      where r.tenant_id = p_tenant_id and r.source = 'manual'
        and r.created_at > now() - interval '24 hours') >= 6 then
    raise exception 'too_many' using errcode = 'P0001';
  end if;
  begin
    insert into public.stock_email_reads (tenant_id, source, requested_by)
    values (p_tenant_id, 'manual', auth.uid())
    returning id into v_id;
  exception when unique_violation then
    select r.id into v_id from public.stock_email_reads r
    where r.tenant_id = p_tenant_id and r.status in ('queued', 'running');
  end;
  return v_id;
end;
$$;

-- Hands the worker the looks that are due, each to one worker. A workspace
-- gets one scheduled look a day, at or after the hour it chose, on its own
-- clock. A look that was claimed and never finished is marked failed; it is
-- not run again by itself.
create function public.claim_stock_email_reads(p_limit int default 3)
returns table (id uuid, tenant_id uuid, source text)
language plpgsql security definer set search_path = ''
as $$
begin
  update public.stock_email_reads r
  set status = 'failed', finished_at = now(), error = 'This read never finished.'
  where r.status = 'running' and r.started_at < now() - interval '30 minutes';

  update public.stock_email_reads r
  set status = 'failed', finished_at = now(),
      error = 'Reading was switched off, or Gmail was disconnected, before this read ran.'
  where r.status = 'queued' and not private.email_reading_on(r.tenant_id);

  -- Kept sixty days; what they filed stays.
  delete from public.stock_email_reads r
  where r.status in ('done', 'failed') and r.created_at < now() - interval '60 days';
  -- A message is remembered for as long as a look could find it again.
  delete from public.stock_email_messages m where m.created_at < now() - interval '400 days';

  insert into public.stock_email_reads (tenant_id, source)
  select t.id, 'schedule'
  from public.tenants t
  join public.configs c
    on c.tenant_id = t.id and c.module = 'stock' and c.key = 'email_sources'
  where private.email_reading_on(t.id)
    and extract(hour from now() at time zone t.timezone) >=
      case when c.body ->> 'read_hour' ~ '^([0-9]|1[0-9]|2[0-3])$'
           then (c.body ->> 'read_hour')::int else 6 end
    and not exists (
      select 1 from public.stock_email_reads r
      where r.tenant_id = t.id
        and (r.status in ('queued', 'running')
             or (r.source = 'schedule'
                 and (r.created_at at time zone t.timezone)::date
                     = (now() at time zone t.timezone)::date)))
  on conflict do nothing;

  return query
  with due as (
    select r.id from public.stock_email_reads r
    where r.status = 'queued'
    order by r.created_at
    limit greatest(1, least(coalesce(p_limit, 3), 10))
    for update skip locked
  )
  update public.stock_email_reads r set status = 'running', started_at = now()
  from due where r.id = due.id
  returning r.id, r.tenant_id, r.source;
end;
$$;

-- Closes a look with what it found.
create function public.finish_stock_email_read(
  p_read_id uuid, p_status text, p_counts jsonb, p_skipped jsonb, p_error text default null
)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_status not in ('done', 'failed') then
    raise exception 'Bad status' using errcode = '22023';
  end if;
  update public.stock_email_reads r
  set status = p_status, finished_at = now(),
      counts = coalesce(p_counts, '{}'::jsonb),
      skipped = coalesce(
        (select jsonb_agg(s.e) from (
           select e from jsonb_array_elements(coalesce(p_skipped, '[]'::jsonb)) e limit 60) s),
        '[]'::jsonb),
      error = left(p_error, 500)
  where r.id = p_read_id and r.status = 'running';
  if not found then
    raise exception 'That read is not underway' using errcode = 'P0002';
  end if;
end;
$$;

-- Writes down a forwarded message or an uploaded file that was read: the
-- same record a look leaves, made in one go.
create function public.record_stock_email_read(
  p_tenant_id uuid, p_source text, p_counts jsonb, p_skipped jsonb, p_actor uuid default null
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid := gen_random_uuid();
begin
  if p_source not in ('forward', 'upload') then
    raise exception 'Bad source' using errcode = '22023';
  end if;
  -- Made finished from the start, so it never stands in the way of a look.
  insert into public.stock_email_reads
    (id, tenant_id, status, source, requested_by, started_at, finished_at, counts, skipped)
  values
    (v_id, p_tenant_id, 'done', p_source, p_actor, now(), now(), coalesce(p_counts, '{}'::jsonb),
     coalesce(
       (select jsonb_agg(s.e) from (
          select e from jsonb_array_elements(coalesce(p_skipped, '[]'::jsonb)) e limit 60) s),
       '[]'::jsonb));
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Filing
-- ---------------------------------------------------------------------------

-- The one way an emailed (or uploaded) entry reaches a supplier's account.
-- Called with the service role for one named workspace.
--
--   p_message  what is kept about the message, or null for an uploaded file:
--              {"message_key", "route", "gmail_id", "thread_id", "sent_at",
--               "sender", "subject", "supplier_id", "notes": [{what, reason}],
--               "pending": {"sent_day", "documents"}}
--              `pending` is given when nobody could say whose mail it is: the
--              facts wait in `stock_email_pending` for a manager.
--   p_entries  [{"supplier_id", "type", "entry_date", "amount",
--               "stated_balance", "reference", "description", "external_key",
--               "needs_review", "review_note", "reported_by"}]
--   p_pending_id  a waiting message a manager has just given a supplier: its
--              row goes as its entries are filed.
--   p_confirm  false for a look ("Try it"): everything is done and then
--              undone, and the answer says what would have happened.
--
-- Returns {"repeated", "outcome", "results": [{"external_key", "outcome",
-- "detail", "id"}]}, each entry's outcome one of:
--   added          filed
--   changed        an emailed invoice's newer copy has another amount: the
--                  entry follows it and is marked to check
--   flagged        a typed-in invoice of that number has another amount: the
--                  typed figure is left alone and marked to check
--   same           already there
--   covered        dated on or before the supplier's latest statement
--   older_statement  a statement older than the one on file
--   have_already   that payment is on the account already
--   taken_off      a manager removed it before
create function public.file_email_entries(
  p_tenant_id uuid,
  p_message jsonb,
  p_entries jsonb,
  p_read_id uuid default null,
  p_pending_id uuid default null,
  p_confirm boolean default true,
  p_actor uuid default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  r record;
  v_row public.supplier_ledger;
  v_key text := nullif(p_message ->> 'message_key', '');
  v_route text := p_message ->> 'route';
  v_gmail text := nullif(p_message ->> 'gmail_id', '');
  v_thread text := nullif(p_message ->> 'thread_id', '');
  v_supplier uuid := nullif(p_message ->> 'supplier_id', '')::uuid;
  v_results jsonb := '[]'::jsonb;
  v_outcome text;
  v_detail text;
  v_id uuid;
  v_anchor date;
  v_date date;
  v_ref text;
  v_note text;
  v_wrote int := 0;
  v_check int := 0;
  v_message_outcome text;
begin
  if jsonb_typeof(coalesce(p_entries, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_entries, '[]'::jsonb)) > 40 then
    raise exception 'Bad entries' using errcode = '22023';
  end if;
  if p_message is not null and (v_key is null or v_route not in ('gmail', 'forward')) then
    raise exception 'Bad message' using errcode = '22023';
  end if;
  if v_supplier is not null and not exists (
    select 1 from public.suppliers s where s.id = v_supplier and s.tenant_id = p_tenant_id
  ) then
    raise exception 'Supplier not found' using errcode = 'P0002';
  end if;
  if p_pending_id is not null and not exists (
    select 1 from public.stock_email_pending p
    where p.id = p_pending_id and p.tenant_id = p_tenant_id
      and p.message_key is not distinct from v_key
  ) then
    raise exception 'That message is not waiting' using errcode = 'P0002';
  end if;
  -- The same message a second time files nothing.
  if v_key is not null and p_pending_id is null and coalesce(p_confirm, true) and exists (
    select 1 from public.stock_email_messages m
    where m.tenant_id = p_tenant_id and m.message_key = v_key
  ) then
    return jsonb_build_object('repeated', true, 'outcome', null, 'results', '[]'::jsonb);
  end if;

  begin
    for r in
      select e.supplier_id, lower(e.type) as type, e.entry_date,
             case when lower(e.type) = 'statement' then 0 else round(coalesce(e.amount, 0), 2) end
               as amount,
             case when lower(e.type) = 'statement' then round(e.stated_balance, 2) end
               as stated_balance,
             nullif(left(btrim(coalesce(e.reference, '')), 80), '') as reference,
             left(btrim(coalesce(e.description, '')), 500) as description,
             e.external_key, coalesce(e.needs_review, false) as needs_review,
             nullif(left(btrim(coalesce(e.review_note, '')), 500), '') as review_note,
             e.reported_by
      from jsonb_to_recordset(coalesce(p_entries, '[]'::jsonb)) as e(
        supplier_id uuid, type text, entry_date date, amount numeric, stated_balance numeric,
        reference text, description text, external_key text, needs_review boolean,
        review_note text, reported_by text)
      -- Statements first: what they cover is then left out in the same go.
      order by (lower(e.type) = 'statement') desc, e.entry_date, e.external_key
    loop
      if r.type not in ('statement', 'invoice', 'payment') or r.entry_date is null
         or r.entry_date < date '2000-01-01' or r.entry_date > current_date + 1
         or (r.type <> 'statement' and (r.amount <= 0 or r.amount > 100000000))
         or (r.type = 'statement'
             and (r.stated_balance is null or abs(r.stated_balance) > 100000000))
         or (r.type = 'invoice' and r.reference is null)
         or r.external_key is null or char_length(r.external_key) > 120
         or (r.reported_by is not null
             and (r.type <> 'payment' or r.reported_by not in ('supplier', 'bank')))
         -- A key belongs to its message: nothing can be filed under another's.
         or (v_key is not null and left(r.external_key, char_length(v_key) + 6) <> 'mail:' || v_key || ':')
         or (v_key is null and r.external_key !~ '^upload:[0-9a-f]{16,64}:') then
        raise exception 'That entry is not valid' using errcode = '22023';
      end if;
      if not exists (
        select 1 from public.suppliers s where s.id = r.supplier_id and s.tenant_id = p_tenant_id
      ) then
        raise exception 'Supplier not found' using errcode = 'P0002';
      end if;
      -- One supplier's account at a time, so two reads can't both add the same thing.
      perform 1 from public.suppliers s where s.id = r.supplier_id for update;

      v_outcome := null;
      v_detail := null;
      v_id := null;
      v_ref := case when r.type = 'invoice' then private.ledger_ref_key(r.reference) end;
      select max(l.entry_date) into v_anchor from public.supplier_ledger l
      where l.tenant_id = p_tenant_id and l.supplier_id = r.supplier_id and l.type = 'statement';

      if exists (
        select 1 from public.supplier_ledger_skips k
        where k.tenant_id = p_tenant_id and k.supplier_id = r.supplier_id
          and (k.external_key = r.external_key
               or (v_ref is not null and v_ref <> '' and k.external_key = left('ref:inv:' || v_ref, 120)))
      ) then
        v_outcome := 'taken_off';
      elsif exists (
        select 1 from public.supplier_ledger l
        where l.tenant_id = p_tenant_id and l.supplier_id = r.supplier_id
          and l.external_key = r.external_key
      ) then
        v_outcome := 'same';
      elsif r.type = 'statement' then
        if exists (
          select 1 from public.supplier_ledger l
          where l.tenant_id = p_tenant_id and l.supplier_id = r.supplier_id
            and l.type = 'statement' and l.entry_date = r.entry_date
            and l.stated_balance = r.stated_balance
        ) then
          v_outcome := 'same';
        elsif v_anchor is not null and r.entry_date < v_anchor then
          v_outcome := 'older_statement';
          v_detail := v_anchor::text;
        end if;
      elsif r.type = 'invoice' then
        select l.* into v_row from public.supplier_ledger l
        where l.tenant_id = p_tenant_id and l.supplier_id = r.supplier_id and l.type = 'invoice'
          and private.ledger_ref_key(l.reference) = v_ref
        order by l.created_at limit 1;
        -- An invoice keeps the date it was first billed: a copy sent again
        -- later never moves it past a statement that already counted it.
        v_date := least(r.entry_date, v_row.entry_date);
        if v_anchor is not null and v_date <= v_anchor then
          v_outcome := 'covered';
          v_detail := v_anchor::text;
        elsif v_row.id is not null and v_row.amount = r.amount then
          v_outcome := 'same';
          v_id := v_row.id;
        elsif v_row.id is not null and v_row.source in ('email', 'upload') then
          -- The newest copy wins, and a person is asked to look.
          update public.supplier_ledger l
          set amount = r.amount, entry_date = v_date, needs_review = true,
              review_note = left('An earlier copy of ' || r.reference || ' said '
                || v_row.amount::text || '; this one says ' || r.amount::text
                || '. Check it''s a revised invoice, not a separate one.', 500),
              mail_route = case when v_key is not null then v_route else l.mail_route end,
              mail_message_id = case when v_key is not null then v_gmail else l.mail_message_id end,
              mail_thread_id = case when v_key is not null then v_thread else l.mail_thread_id end
          where l.id = v_row.id;
          v_outcome := 'changed';
          v_id := v_row.id;
          v_wrote := v_wrote + 1;
          v_check := v_check + 1;
        elsif v_row.id is not null then
          -- What a person wrote down is left as it is; they are told.
          update public.supplier_ledger l
          set needs_review = true,
              review_note = left('A copy read from email says ' || r.amount::text
                || '; this entry says ' || v_row.amount::text || '.', 500)
          where l.id = v_row.id;
          v_outcome := 'flagged';
          v_id := v_row.id;
          v_wrote := v_wrote + 1;
          v_check := v_check + 1;
        end if;
      else
        if v_anchor is not null and r.entry_date <= v_anchor then
          v_outcome := 'covered';
          v_detail := v_anchor::text;
        elsif exists (
          select 1 from public.supplier_ledger l
          where l.tenant_id = p_tenant_id and l.supplier_id = r.supplier_id
            and l.type = 'payment' and l.amount = r.amount
            and (
              -- Written down by hand already: the same amount within five days.
              (l.source in ('manual', 'import') and abs(l.entry_date - r.entry_date) <= 5)
              -- Seen from our side twice: the bank's notice and the books.
              or (r.reported_by = 'bank' and l.source = 'books'
                  and abs(l.entry_date - r.entry_date) <= 5)
              -- The same notice arriving by another road, under another key.
              or (l.source in ('email', 'upload') and l.entry_date = r.entry_date
                  and l.reported_by is not distinct from r.reported_by))
        ) then
          v_outcome := 'have_already';
        end if;
      end if;

      if v_outcome is null then
        insert into public.supplier_ledger
          (tenant_id, supplier_id, type, entry_date, amount, stated_balance, reference,
           description, source, external_key, needs_review, review_note, reported_by,
           mail_route, mail_message_id, mail_thread_id, created_by)
        values
          (p_tenant_id, r.supplier_id, r.type, r.entry_date, r.amount, r.stated_balance,
           r.reference, r.description, case when v_key is null then 'upload' else 'email' end,
           r.external_key, r.needs_review, case when r.needs_review then r.review_note end,
           r.reported_by, case when v_key is not null then v_route end,
           case when v_key is not null then v_gmail end,
           case when v_key is not null then v_thread end, p_actor)
        returning id into v_id;
        v_outcome := 'added';
        v_wrote := v_wrote + 1;
        if r.needs_review then v_check := v_check + 1; end if;
      end if;
      v_results := v_results || jsonb_build_object(
        'external_key', r.external_key, 'outcome', v_outcome, 'detail', v_detail, 'id', v_id);
    end loop;

    v_message_outcome := case
      when v_check > 0 then 'to_check'
      when v_wrote > 0 then 'filed'
      when p_message -> 'pending' is not null and jsonb_typeof(p_message -> 'pending') = 'object'
        then 'unassigned'
      else 'skipped' end;

    if v_key is not null then
      if p_pending_id is not null then
        delete from public.stock_email_pending p
        where p.id = p_pending_id and p.tenant_id = p_tenant_id;
        update public.stock_email_messages m
        set outcome = v_message_outcome, supplier_id = v_supplier
        where m.tenant_id = p_tenant_id and m.message_key = v_key;
      else
        insert into public.stock_email_messages
          (tenant_id, message_key, route, gmail_id, thread_id, sent_at, sender, subject,
           supplier_id, outcome, notes, read_id)
        values
          (p_tenant_id, v_key, v_route, v_gmail, v_thread,
           nullif(p_message ->> 'sent_at', '')::timestamptz,
           left(coalesce(p_message ->> 'sender', ''), 200),
           left(coalesce(p_message ->> 'subject', ''), 300),
           v_supplier, v_message_outcome,
           coalesce(
             (select jsonb_agg(s.e) from (
                select e from jsonb_array_elements(
                  case when jsonb_typeof(p_message -> 'notes') = 'array'
                       then p_message -> 'notes' else '[]'::jsonb end) e limit 30) s),
             '[]'::jsonb),
           p_read_id)
        on conflict (tenant_id, message_key) do nothing;
        if v_message_outcome = 'unassigned' then
          insert into public.stock_email_pending
            (tenant_id, message_key, sent_day, sender, subject, documents)
          values
            (p_tenant_id, v_key, (p_message -> 'pending' ->> 'sent_day')::date,
             left(coalesce(p_message ->> 'sender', ''), 200),
             left(coalesce(p_message ->> 'subject', ''), 300),
             p_message -> 'pending' -> 'documents')
          on conflict (tenant_id, message_key) do nothing;
        end if;
      end if;
    end if;

    if not coalesce(p_confirm, true) then
      raise exception 'look' using errcode = 'MAILK';
    end if;
  exception when sqlstate 'MAILK' then
    null;
  end;
  return jsonb_build_object(
    'repeated', false, 'outcome', v_message_outcome, 'results', v_results);
end;
$$;

-- ---------------------------------------------------------------------------
-- What a manager does with what was read
-- ---------------------------------------------------------------------------

-- "Looks right": the entry has been checked.
create function public.settle_ledger_review(p_tenant_id uuid, p_entry_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_manager(p_tenant_id);
  update public.supplier_ledger l set needs_review = false, review_note = null
  where l.id = p_entry_id and l.tenant_id = p_tenant_id;
  if not found then
    raise exception 'Entry not found' using errcode = 'P0002';
  end if;
end;
$$;

-- Puts away a message that was waiting for a supplier, filing nothing.
create function public.discard_email_pending(p_tenant_id uuid, p_pending_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_key text;
begin
  perform private.require_manager(p_tenant_id);
  delete from public.stock_email_pending p
  where p.id = p_pending_id and p.tenant_id = p_tenant_id
  returning p.message_key into v_key;
  if not found then
    raise exception 'That message is not waiting' using errcode = 'P0002';
  end if;
  update public.stock_email_messages m set outcome = 'skipped'
  where m.tenant_id = p_tenant_id and m.message_key = v_key;
end;
$$;

-- Removing an entry, as before. One a machine filed is also noted as
-- skipped, so it stays removed; an emailed invoice is noted by its number as
-- well, so another copy of it in a later email stays off too.
create or replace function public.remove_ledger_entry(p_tenant_id uuid, p_entry_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.supplier_ledger;
  v_ref text;
begin
  perform private.require_manager(p_tenant_id);
  delete from public.supplier_ledger l where l.id = p_entry_id and l.tenant_id = p_tenant_id
  returning * into v_row;
  if not found then
    raise exception 'Entry not found' using errcode = 'P0002';
  end if;
  if v_row.external_key is not null then
    insert into public.supplier_ledger_skips (tenant_id, supplier_id, external_key, skipped_by)
    values (v_row.tenant_id, v_row.supplier_id, v_row.external_key, (select auth.uid()))
    on conflict do nothing;
  end if;
  v_ref := private.ledger_ref_key(v_row.reference);
  if v_row.source in ('email', 'upload') and v_row.type = 'invoice' and v_ref <> '' then
    insert into public.supplier_ledger_skips (tenant_id, supplier_id, external_key, skipped_by)
    values (v_row.tenant_id, v_row.supplier_id, left('ref:inv:' || v_ref, 120), (select auth.uid()))
    on conflict do nothing;
  end if;
end;
$$;

-- Payments read from the books, as before, with one more thing counted as
-- "already there": the bank's own notice of that payment, read from email.
-- Both are the business's side of the same money leaving.
create or replace function public.import_book_payments(p_tenant_id uuid, p_provider text, p_rows jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  r record;
  v_supplier uuid;
  v_from date;
  v_key text;
  v_note text;
  v_added int := 0;
  v_changed int := 0;
  v_same int := 0;
  v_unmatched int := 0;
  v_before int := 0;
  v_typed int := 0;
  v_skipped int := 0;
  v_read int := 0;
begin
  if p_provider is distinct from 'quickbooks' then
    raise exception 'Only the books connection files payments' using errcode = '22023';
  end if;
  if not public.book_payments_wanted(p_tenant_id, p_provider) then
    return jsonb_build_object('off', true);
  end if;
  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) > 5000 then
    raise exception 'Bad rows' using errcode = '22023';
  end if;

  for r in
    select nullif(btrim(i.external_id), '') as external_id,
           coalesce(nullif(btrim(i.kind), ''), 'txn') as kind,
           i.date as day, nullif(btrim(i.payee), '') as payee,
           round(i.amount, 2) as amount, left(btrim(coalesce(i.memo, '')), 300) as memo
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as i(
      external_id text, kind text, date date, payee text, amount numeric, memo text)
  loop
    v_read := v_read + 1;
    if r.external_id is null or r.day is null or r.payee is null or r.amount is null
       or r.amount <= 0 or r.amount > 100000000
       or r.kind !~ '^[A-Za-z]{1,30}$' or char_length(r.external_id) > 60 then
      v_unmatched := v_unmatched + 1;
      continue;
    end if;
    select s.id into v_supplier from public.suppliers s
    where s.tenant_id = p_tenant_id and lower(btrim(s.name)) = lower(r.payee)
    order by (s.archived_at is null) desc, s.created_at limit 1;
    if v_supplier is null then
      v_unmatched := v_unmatched + 1;
      continue;
    end if;
    select min(l.entry_date) into v_from from public.supplier_ledger l
    where l.tenant_id = p_tenant_id and l.supplier_id = v_supplier
      and l.type in ('invoice', 'statement');
    if v_from is null or r.day < v_from then
      v_before := v_before + 1;
      continue;
    end if;
    v_key := 'qbo:' || r.kind || ':' || r.external_id;
    if exists (
      select 1 from public.supplier_ledger_skips k
      where k.tenant_id = p_tenant_id and k.supplier_id = v_supplier and k.external_key = v_key
    ) then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    v_note := left('From your books (QuickBooks)'
      || case when r.memo <> '' then ' · ' || r.memo else '' end, 500);
    if exists (
      select 1 from public.supplier_ledger l
      where l.tenant_id = p_tenant_id and l.supplier_id = v_supplier and l.external_key = v_key
    ) then
      update public.supplier_ledger l
      set entry_date = r.day, amount = r.amount, description = v_note
      where l.tenant_id = p_tenant_id and l.supplier_id = v_supplier and l.external_key = v_key
        and (l.entry_date <> r.day or l.amount <> r.amount or l.description <> v_note);
      if found then v_changed := v_changed + 1; else v_same := v_same + 1; end if;
      continue;
    end if;
    -- Typed in by hand already, or told by the bank's own notice? The same
    -- amount within five days is the same payment.
    if exists (
      select 1 from public.supplier_ledger l
      where l.tenant_id = p_tenant_id and l.supplier_id = v_supplier and l.type = 'payment'
        and (l.external_key is null or l.reported_by = 'bank') and l.amount = r.amount
        and abs(l.entry_date - r.day) <= 5
    ) then
      v_typed := v_typed + 1;
      continue;
    end if;
    insert into public.supplier_ledger
      (tenant_id, supplier_id, type, entry_date, amount, description, source, external_key)
    values (p_tenant_id, v_supplier, 'payment', r.day, r.amount, v_note, 'books', v_key);
    v_added := v_added + 1;
  end loop;
  return jsonb_build_object(
    'read', v_read, 'added', v_added, 'changed', v_changed, 'same', v_same,
    'no_supplier', v_unmatched, 'before_account', v_before, 'typed_already', v_typed,
    'taken_off', v_skipped);
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
    'public.claim_stock_email_reads(int)',
    'public.finish_stock_email_read(uuid, text, jsonb, jsonb, text)',
    'public.record_stock_email_read(uuid, text, jsonb, jsonb, uuid)',
    'public.file_email_entries(uuid, jsonb, jsonb, uuid, uuid, boolean, uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
  foreach fn in array array[
    'public.request_stock_email_read(uuid)',
    'public.settle_ledger_review(uuid, uuid)',
    'public.discard_email_pending(uuid, uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;
