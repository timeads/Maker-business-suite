-- Money → Debts: "Also in your books" items a person hides. OWNERS AND
-- ADMINS ONLY, as everything about debts.
--
-- Hiding is only about that list: a hidden liability is folded under
-- "Hidden (n)" with "Show again", and it sticks across syncs (the sync never
-- writes these columns). It never changes whether something counts as a
-- debt: that stays `choice` and the workspace's rule.

alter table public.money_book_accounts
  add column hidden_at timestamptz,
  add column hidden_by uuid references auth.users (id) on delete set null;

create function public.hide_book_liability(p_tenant_id uuid, p_account_id uuid, p_hidden boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_manager(p_tenant_id);
  if p_hidden is null then
    raise exception 'Hide it or show it again' using errcode = '22023';
  end if;
  update public.money_book_accounts a
  set hidden_at = case when p_hidden then coalesce(a.hidden_at, now()) end,
      hidden_by = case when p_hidden then coalesce(a.hidden_by, auth.uid()) end
  where a.id = p_account_id and a.tenant_id = p_tenant_id;
  if not found then
    raise exception 'That account isn''t here' using errcode = 'P0002';
  end if;
end;
$$;
revoke all on function public.hide_book_liability(uuid, uuid, boolean) from public, anon;
grant execute on function public.hide_book_liability(uuid, uuid, boolean) to authenticated;
