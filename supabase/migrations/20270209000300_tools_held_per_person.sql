-- Each tool's own tables are held for the people who have that tool, once a
-- workspace chooses tools per person. While the switch is off every member
-- has every tool, so nothing here changes what anyone reads or writes.
--
-- The same two holds as Money's (20270209000200):
--   * a RESTRICTIVE select policy, ANDed with each table's own policy: the
--     tool's people may read, and so may the people of the tools that read
--     this one's rows to do their own job (listed beside each table);
--   * a write trigger (`private.tool_write_guard`) that refuses a signed-in
--     person without the tool, whichever checked function they called. The
--     worker, the sync and webhooks have no signed-in person and are
--     untouched.
--
-- Reads across tools, decided one by one (docs/roles.md has the list):
--   * Help desk's rail shows the customer's parcels and when an item is back
--     in stock, so help desk people read Shipping's orders and parcels and
--     Stock's items and incoming orders.
--   * Shipping, Social and Bookings show the shop's items (photos, weights,
--     supplies), so their people read Stock's items.
--   * Help desk answers Instagram and Facebook as a Page, so help desk people
--     read Social's accounts; Shipping, Stock and the help desk use the logo
--     asset, so they read Social's assets.
--   * Money (owners and admins) reads everything already.
-- The shop's own records (orders, their lines, customers, products) stay
-- the whole team's: every tool works from them.

do $$
declare
  spec record;
begin
  for spec in
    select * from (values
      -- Help desk
      ('tickets', 'helpdesk', array['helpdesk']),
      ('messages', 'helpdesk', array['helpdesk']),
      ('message_attachments', 'helpdesk', array['helpdesk']),
      ('ticket_events', 'helpdesk', array['helpdesk']),
      ('ticket_folders', 'helpdesk', array['helpdesk']),
      ('ticket_notes', 'helpdesk', array['helpdesk']),
      ('ticket_reads', 'helpdesk', array['helpdesk']),
      ('ticket_tags', 'helpdesk', array['helpdesk']),
      ('tags', 'helpdesk', array['helpdesk']),
      ('contacts', 'helpdesk', array['helpdesk']),
      ('comment_posts', 'helpdesk', array['helpdesk']),
      ('manual_articles', 'helpdesk', array['helpdesk']),
      ('manual_reads', 'helpdesk', array['helpdesk']),
      ('manual_runs', 'helpdesk', array['helpdesk']),
      ('manual_suggestions', 'helpdesk', array['helpdesk']),
      ('manual_topic_cases', 'helpdesk', array['helpdesk']),
      ('manual_topic_media', 'helpdesk', array['helpdesk']),
      ('manual_topic_revisions', 'helpdesk', array['helpdesk']),
      ('manual_topic_sources', 'helpdesk', array['helpdesk']),
      ('manual_topics', 'helpdesk', array['helpdesk']),
      ('help_article_pictures', 'helpdesk', array['helpdesk']),
      ('help_article_slugs', 'helpdesk', array['helpdesk']),
      -- Bookings
      ('services', 'bookings', array['bookings']),
      ('sessions', 'bookings', array['bookings']),
      ('bookings', 'bookings', array['bookings']),
      ('availability_rules', 'bookings', array['bookings']),
      ('waitlist', 'bookings', array['bookings']),
      ('booking_daily_emails', 'bookings', array['bookings']),
      ('booking_emails', 'bookings', array['bookings']),
      ('booking_imports', 'bookings', array['bookings']),
      ('booking_messages', 'bookings', array['bookings']),
      ('booking_text_opt_outs', 'bookings', array['bookings']),
      ('booking_texts', 'bookings', array['bookings']),
      ('session_seat_groups', 'bookings', array['bookings']),
      ('session_costs', 'bookings', array['bookings']),
      ('class_supplies', 'bookings', array['bookings']),
      ('class_supply_entries', 'bookings', array['bookings']),
      ('class_supply_orders', 'bookings', array['bookings']),
      ('class_supply_services', 'bookings', array['bookings']),
      ('class_vendors', 'bookings', array['bookings']),
      ('budget_fixed_costs', 'bookings', array['bookings']),
      ('budget_material_rates', 'bookings', array['bookings']),
      ('budget_other_income', 'bookings', array['bookings']),
      ('eventbrite_listings', 'bookings', array['bookings']),
      ('shop_undated_lines', 'bookings', array['bookings']),
      ('shop_order_tags', 'bookings', array['bookings']),
      -- Social (and the email builder, which lives in it)
      ('social_posts', 'social', array['social']),
      ('social_accounts', 'social', array['social', 'helpdesk']),
      ('social_assets', 'social', array['social', 'shipping', 'stock', 'helpdesk']),
      ('social_folders', 'social', array['social']),
      ('social_month_runs', 'social', array['social']),
      ('social_post_edits', 'social', array['social']),
      ('social_post_versions', 'social', array['social']),
      ('social_projects', 'social', array['social']),
      ('emails', 'social', array['social']),
      -- Stock (and Michaels, which lives under it)
      ('stock_items', 'stock', array['stock', 'helpdesk', 'shipping', 'social', 'bookings']),
      ('stock_receipts', 'stock', array['stock']),
      ('stock_daily_counts', 'stock', array['stock']),
      ('stock_imports', 'stock', array['stock']),
      ('stock_bills_addresses', 'stock', array['stock']),
      ('stock_email_messages', 'stock', array['stock']),
      ('stock_email_pending', 'stock', array['stock']),
      ('stock_email_reads', 'stock', array['stock']),
      ('purchase_orders', 'stock', array['stock', 'helpdesk']),
      ('purchase_order_lines', 'stock', array['stock', 'helpdesk']),
      ('purchase_order_shipments', 'stock', array['stock', 'helpdesk']),
      ('purchase_order_shipment_items', 'stock', array['stock', 'helpdesk']),
      ('purchase_order_emails', 'stock', array['stock']),
      ('purchase_order_events', 'stock', array['stock']),
      ('suppliers', 'stock', array['stock']),
      ('supplier_closures', 'stock', array['stock']),
      ('supplier_ledger', 'stock', array['stock']),
      ('supplier_ledger_skips', 'stock', array['stock']),
      ('michaels_runs', 'stock', array['stock']),
      ('michaels_listings', 'stock', array['stock']),
      ('michaels_orders', 'stock', array['stock']),
      ('michaels_order_lines', 'stock', array['stock']),
      ('michaels_pairings', 'stock', array['stock']),
      ('michaels_alerts', 'stock', array['stock']),
      -- Shipping
      ('shipping_orders', 'shipping', array['shipping', 'helpdesk']),
      ('shipments', 'shipping', array['shipping', 'helpdesk']),
      ('shipping_boxes', 'shipping', array['shipping']),
      ('shipping_groups', 'shipping', array['shipping']),
      ('shipping_label_batches', 'shipping', array['shipping']),
      ('shipping_label_files', 'shipping', array['shipping']),
      ('shipping_label_quotes', 'shipping', array['shipping']),
      ('shipping_order_plans', 'shipping', array['shipping']),
      ('shipping_packings', 'shipping', array['shipping'])
    ) as s (tbl, tool, readers)
  loop
    execute format(
      'create policy "only people with the tool read it" on public.%I as restrictive
         for select to authenticated
         using (tenant_id in (select private.tool_tenant_ids(%L::text[])))',
      spec.tbl, spec.readers);
    execute format(
      'create trigger tool_write_guard before insert or update or delete on public.%I
         for each row execute function private.tool_write_guard(%L)',
      spec.tbl, spec.tool);
  end loop;
end;
$$;
