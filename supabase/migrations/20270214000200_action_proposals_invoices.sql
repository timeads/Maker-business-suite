-- The assistant may propose how invoices are sorted into lines
-- (`money.invoice_sort`), on the same road as `money.expense_sort`: anyone
-- with Money files it, a person sees the preview, and an owner or admin
-- applies it through `sort_book_invoices`, as themselves. One proposal may
-- be about several invoices (up to 20), so it has no single target: the
-- invoices' ids are in the body, written by the app from the references
-- the model used (`I1`…), and each must be this workspace's and still in
-- the books. Not about debts, so the whole team sees it, as it sees invoices.
--
-- During the deploy an earlier build files only the kinds it knows; nothing
-- it does changes.

alter table public.action_proposals drop constraint if exists action_proposals_kind_check;
alter table public.action_proposals add constraint action_proposals_kind_check
  check (kind in (
    'money.debt_details', 'money.debt_cover', 'money.liability_choice', 'money.liability_hide',
    'money.expense_sort', 'money.budget', 'money.charge', 'money.invoice_sort'));
alter table public.action_proposals drop constraint if exists action_proposals_target_when_needed;
alter table public.action_proposals add constraint action_proposals_target_when_needed
  check ((target is null) = (kind in ('money.budget', 'money.charge', 'money.invoice_sort')));

create or replace function public.propose_action(
  p_tenant_id uuid, p_kind text, p_target uuid, p_body jsonb, p_summary text
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_ids uuid[];
begin
  if p_kind is null or p_kind not in (
    'money.debt_details', 'money.debt_cover', 'money.liability_choice', 'money.liability_hide',
    'money.expense_sort', 'money.budget', 'money.charge', 'money.invoice_sort') then
    raise exception 'There is no such proposal' using errcode = '22023';
  end if;
  if private.action_owners_only(p_kind) then
    perform private.require_manager(p_tenant_id);
  elsif p_tenant_id not in (select private.user_tenant_ids()) then
    raise exception 'Not a member of this workspace' using errcode = '42501';
  end if;
  if p_body is null or jsonb_typeof(p_body) <> 'object' then
    raise exception 'Send what would change' using errcode = '22023';
  end if;
  if p_summary is null or btrim(p_summary) = '' then
    raise exception 'Say what would change' using errcode = '22023';
  end if;
  if p_kind in ('money.debt_details', 'money.debt_cover') then
    if not exists (select 1 from public.money_debts d
                   where d.id = p_target and d.tenant_id = p_tenant_id) then
      raise exception 'That debt isn''t here' using errcode = 'P0002';
    end if;
  elsif p_kind in ('money.liability_choice', 'money.liability_hide') then
    if not exists (select 1 from public.money_book_accounts a
                   where a.id = p_target and a.tenant_id = p_tenant_id) then
      raise exception 'That account isn''t here' using errcode = 'P0002';
    end if;
  elsif p_kind = 'money.expense_sort' then
    if not exists (select 1 from public.book_expenses e
                   where e.id = p_target and e.tenant_id = p_tenant_id
                     and not e.is_move and e.removed_at is null) then
      raise exception 'That expense isn''t here' using errcode = 'P0002';
    end if;
  elsif p_kind = 'money.invoice_sort' then
    if p_target is not null then
      raise exception 'This kind of proposal is about no one row' using errcode = '22023';
    end if;
    if jsonb_typeof(p_body -> 'invoices') is distinct from 'array'
       or jsonb_array_length(p_body -> 'invoices') not between 1 and 20
       or exists (select 1 from jsonb_array_elements(p_body -> 'invoices') v
                  where jsonb_typeof(v) <> 'string'
                     or (v #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    then
      raise exception 'Name between 1 and 20 invoices' using errcode = '22023';
    end if;
    select array_agg(distinct (v #>> '{}')::uuid) into v_ids
    from jsonb_array_elements(p_body -> 'invoices') v;
    if (select count(*) from public.book_invoices b
        where b.tenant_id = p_tenant_id and b.id = any (v_ids) and b.removed_at is null)
       <> cardinality(v_ids) then
      raise exception 'Those invoices aren''t here' using errcode = 'P0002';
    end if;
  elsif p_target is not null then
    raise exception 'This kind of proposal is about no one row' using errcode = '22023';
  end if;
  insert into public.action_proposals (tenant_id, kind, target, body, summary, created_by)
  values (p_tenant_id, p_kind, p_target, p_body, left(btrim(p_summary), 500), auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;
