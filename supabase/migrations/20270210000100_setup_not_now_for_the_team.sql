-- "Finish setting up" for Stock and Shipping (lib/stock/setup.ts,
-- lib/shipping/setup.ts). Unlike Money's, their checklists are shown to the
-- whole team that has the tool: an item only owners and admins can do says
-- "Ask an owner or admin". So when an owner or admin says "Not now" to one,
-- the rest of that tool's team should see it resting too, rather than be
-- nagged about something already decided.
--
-- Additive: one more SELECT policy. Members read only the rows of a tool
-- they have (`private.tool_tenant_ids`), and only Stock's and Shipping's:
-- Money's rows (which can be about debts) stay owners' and admins' alone.
-- Writing is unchanged: `say_setup_not_now` / `bring_back_setup_item` still
-- require an owner or admin.

create policy "the team reads its tools' setup choices" on public.setup_not_now
  for select to authenticated
  using (
    tool in ('stock', 'shipping')
    and tenant_id in (select private.tool_tenant_ids(array[tool]))
  );
