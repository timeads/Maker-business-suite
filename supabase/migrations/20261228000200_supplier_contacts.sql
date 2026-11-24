-- Who an order is addressed to. A purchase order as the supplier receives it
-- names a person and can go to more than one address (sales and accounts,
-- say), so a supplier keeps a contact name and a few more emails beside the
-- one it already had.

alter table public.suppliers
  add column contact_name text
    check (contact_name is null or char_length(contact_name) between 1 and 120),
  -- Further addresses, after `email`. Lower case, at most five.
  add column more_emails text[] not null default '{}'
    check (cardinality(more_emails) <= 5);

-- Owners and admins only, like everything else about a supplier. Kept apart
-- from save_supplier so that function stays as it is.
create function public.save_supplier_contact(
  p_tenant_id uuid, p_supplier_id uuid, p_contact_name text, p_more_emails text[]
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_emails text[];
begin
  perform private.require_manager(p_tenant_id);
  select coalesce(array_agg(distinct e), '{}')
  into v_emails
  from (
    select nullif(lower(btrim(x)), '') as e from unnest(coalesce(p_more_emails, '{}')) as x
  ) cleaned
  where e is not null;
  if cardinality(v_emails) > 5 then
    raise exception 'Too many emails' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(v_emails) as e
    where char_length(e) > 200 or e !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ) then
    raise exception 'Bad email' using errcode = '22023';
  end if;
  update public.suppliers s
  set contact_name = nullif(left(btrim(coalesce(p_contact_name, '')), 120), ''),
      more_emails = v_emails
  where s.id = p_supplier_id and s.tenant_id = p_tenant_id;
  if not found then
    raise exception 'Supplier not found' using errcode = 'P0002';
  end if;
end;
$$;
revoke all on function public.save_supplier_contact(uuid, uuid, text, text[]) from public, anon;
grant execute on function public.save_supplier_contact(uuid, uuid, text, text[]) to authenticated;
