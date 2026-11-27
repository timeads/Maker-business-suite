-- More of the assistant's Money proposals that aren't settings, and a
-- history of the ones a person applied.
--
-- New kinds, on the same road as the debt ones (propose -> preview -> a
-- person applies it through the existing checked function, as that person):
-- - `money.expense_sort`: how one expense is sorted (`sort_book_expenses`);
--   the target is the expense;
-- - `money.budget`: one month's budget amounts (`set_money_budgets`); no
--   target, the month and amounts are in the body;
-- - `money.charge`: a cost cutter decision about one recurring charge
--   (`decide_money_charge`); no target, the charge's key is in the body.
-- None of these is about debts, so the whole team can see them (as they see
-- expenses, budgets and the cost cutter) and an owner or admin applies them.
-- Debt kinds stay for owners and admins only (`private.action_owners_only`).
--
-- History: none of these leave a `config_versions` row, so the words of
-- what changed (before and after, as the person saw them in the preview)
-- are written onto the proposal when it is applied, by the person who
-- applied it, through `note_action_applied`. Who and when are already there
-- (`decided_by`, `decided_at`); the row-level security that hides a debt
-- proposal hides its history too.

alter table public.action_proposals drop constraint if exists action_proposals_kind_check;
alter table public.action_proposals add constraint action_proposals_kind_check
  check (kind in (
    'money.debt_details', 'money.debt_cover', 'money.liability_choice', 'money.liability_hide',
    'money.expense_sort', 'money.budget', 'money.charge'));
alter table public.action_proposals alter column target drop not null;
alter table public.action_proposals add constraint action_proposals_target_when_needed
  check ((target is null) = (kind in ('money.budget', 'money.charge')));
alter table public.action_proposals
  add column applied_before text[] check (cardinality(applied_before) <= 60),
  add column applied_after text[] check (cardinality(applied_after) <= 60);
create index action_proposals_applied_idx on public.action_proposals (tenant_id, decided_at desc)
  where status = 'applied';

-- Files a proposal. A target, where the kind has one, must be this workspace's.
create or replace function public.propose_action(
  p_tenant_id uuid, p_kind text, p_target uuid, p_body jsonb, p_summary text
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_kind is null or p_kind not in (
    'money.debt_details', 'money.debt_cover', 'money.liability_choice', 'money.liability_hide',
    'money.expense_sort', 'money.budget', 'money.charge') then
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
  elsif p_target is not null then
    raise exception 'This kind of proposal is about no one row' using errcode = '22023';
  end if;
  insert into public.action_proposals (tenant_id, kind, target, body, summary, created_by)
  values (p_tenant_id, p_kind, p_target, p_body, left(btrim(p_summary), 500), auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

-- What an applied proposal changed, in the words of its preview. Only the
-- person who applied it, within a few minutes, and only once.
create function public.note_action_applied(p_id uuid, p_before text[], p_after text[])
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if cardinality(coalesce(p_before, '{}')) > 60 or cardinality(coalesce(p_after, '{}')) > 60 then
    raise exception 'Too much to note' using errcode = '22023';
  end if;
  update public.action_proposals p
  set applied_before = (select coalesce(array_agg(left(w, 300)), '{}') from unnest(p_before) w),
      applied_after = (select coalesce(array_agg(left(w, 300)), '{}') from unnest(p_after) w)
  where p.id = p_id and p.status = 'applied' and p.decided_by = auth.uid()
    and p.decided_at > now() - interval '5 minutes'
    and p.applied_before is null and p.applied_after is null
    and private.has_tenant_role(p.tenant_id, array['owner', 'admin']::public.membership_role[]);
end;
$$;
revoke all on function public.note_action_applied(uuid, text[], text[]) from public, anon;
grant execute on function public.note_action_applied(uuid, text[], text[]) to authenticated;
