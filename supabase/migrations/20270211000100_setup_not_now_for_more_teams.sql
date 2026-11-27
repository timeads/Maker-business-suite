-- "Finish setting up" for Bookings, Help desk and Social (lib/bookings/setup.ts,
-- lib/helpdesk/setup.ts, lib/social/setup.ts). Like Stock's and Shipping's,
-- these checklists are shown to everyone with the tool, and an item only
-- owners and admins can do says "Ask an owner or admin". So when an owner or
-- admin says "Not now" to one, that tool's team sees it resting too.
--
-- Nothing in these rows is sensitive: a tool, an item id and a short
-- fingerprint of ids and counts (the classroom budget's item is only
-- "never saved"). Additive: one more SELECT policy, alongside the earlier
-- one for Stock and Shipping (20270210000100), which stays as it is. Members
-- read only the rows of a tool they have (`private.tool_tenant_ids`); Money's
-- rows stay owners' and admins' alone. Writing is unchanged:
-- `say_setup_not_now` / `bring_back_setup_item` still require an owner or
-- admin.

create policy "the team reads more tools' setup choices" on public.setup_not_now
  for select to authenticated
  using (
    tool in ('bookings', 'helpdesk', 'social')
    and tenant_id in (select private.tool_tenant_ids(array[tool]))
  );
