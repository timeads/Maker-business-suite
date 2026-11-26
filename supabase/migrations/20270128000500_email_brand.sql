-- An email is drawn in one brand: the starter's colours, the builder's
-- swatches and logos, and Claude's voice come from that brand's kit. Emails
-- from before brands belong to the workspace's main brand. Nothing else
-- about an email changes; it is still saved through save_email.

alter table public.emails
  add column brand_id uuid references public.brands (id) on delete restrict;

alter table public.emails disable trigger user;
update public.emails e
set brand_id = private.ensure_default_brand(e.tenant_id)
where e.brand_id is null;
alter table public.emails enable trigger user;

-- Says which brand an email is drawn in. Anyone on the team who may write
-- emails; only the workspace's own brands, and not one that is put away.
create function public.set_email_brand(p_tenant_id uuid, p_email_id uuid, p_brand_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_member(p_tenant_id);
  if not exists (
    select 1 from public.brands b
    where b.id = p_brand_id and b.tenant_id = p_tenant_id and b.archived_at is null
  ) then
    raise exception 'Brand not found' using errcode = 'P0002';
  end if;
  update public.emails e set brand_id = p_brand_id
  where e.id = p_email_id and e.tenant_id = p_tenant_id;
  if not found then
    raise exception 'Email not found' using errcode = 'P0002';
  end if;
end;
$$;
revoke all on function public.set_email_brand(uuid, uuid, uuid) from public, anon;
grant execute on function public.set_email_brand(uuid, uuid, uuid) to authenticated;
