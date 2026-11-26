-- Connections: record what a provider says was really granted.
--
-- Our Shopify app uses Shopify-managed installation, and then Shopify ignores
-- the `scope` on the authorize link: a store gets the scopes in the app's
-- released version once the merchant approves them. So a connection's
-- `scopes` must be what the store reports (`currentAppInstallation
-- { accessScopes }`), read after connecting, after each scheduled read of the
-- shop and on a manager's "Check again" (docs/shopify-permissions.md). Every
-- gate already reads `scopes` (`private.shop_can_tag_orders`,
-- `private.shop_can_fulfil`, and their twins in the app), so they follow.
--
-- A watch-only connection keeps only the reading half, whatever the store
-- granted: watch only is our promise that nothing in the store is changed
-- from here, so no gate may ever see a write scope on one.

create function public.record_granted_scopes(
  p_tenant_id uuid,
  p_connection_id uuid,
  p_scopes text[]
)
returns void
language sql security definer set search_path = ''
as $$
  update public.connections c
  set scopes = coalesce(array(
        select distinct s from unnest(coalesce(p_scopes, '{}'::text[])) as s
        where s ~ '^[a-z0-9_]{1,80}$'
          and (coalesce(c.metadata ->> 'watch_only', 'false') <> 'true' or s like 'read\_%')
        order by s), '{}'::text[]),
      metadata = c.metadata || jsonb_build_object('scopes_checked_at', now())
  where c.id = p_connection_id
    and c.tenant_id = p_tenant_id
    and c.status = 'active';
$$;

revoke all on function public.record_granted_scopes(uuid, uuid, text[])
  from public, anon, authenticated;
grant execute on function public.record_granted_scopes(uuid, uuid, text[]) to service_role;
