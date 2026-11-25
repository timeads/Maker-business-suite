-- Two more booking emails.
--   1. When a refund or cancellation in the shop cancels a booking, the
--      customer is told (a switch in bookings / emails, on unless switched
--      off, and only for a date still to come). It goes through the same
--      record as the reminders, so a refusal is tried again.
--   2. "Send the confirmation again": a manager's press. Only the hash of a
--      booking's link is kept, so the press gives the booking a new link and
--      the one in the earlier email stops working.

-- The whole order was cancelled in the shop: its bookings go too. The same
-- job as `cancel_shop_order`, but it says which bookings went, so their
-- people can be told.
create function public.cancel_shop_order_bookings(p_tenant_id uuid, p_order_id text)
returns setof uuid
language sql security definer set search_path = ''
as $$
  update public.bookings b set status = 'cancelled', cancelled_at = now()
  where b.tenant_id = p_tenant_id and b.shop_order_id = p_order_id and b.status = 'confirmed'
  returning b.id;
$$;
revoke all on function public.cancel_shop_order_bookings(uuid, text)
  from public, anon, authenticated;
grant execute on function public.cancel_shop_order_bookings(uuid, text) to service_role;

-- Queues the "your booking was cancelled" email for a booking the shop
-- cancelled. True when one was queued. Once per booking and date, whatever
-- the shop repeats.
create function public.queue_booking_cancel_email(p_tenant_id uuid, p_booking_id uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_rows int;
begin
  insert into public.booking_emails (tenant_id, booking_id, session_id, kind, status)
  select b.tenant_id, b.id, b.session_id, 'cancelled', 'queued'
  from public.bookings b
  join public.sessions s on s.id = b.session_id
  where b.id = p_booking_id and b.tenant_id = p_tenant_id
    and b.status = 'cancelled' and b.shop_order_id is not null
    and b.email_opt_in and b.customer_email <> ''
    -- Cancelling a booking on a class that already happened is bookkeeping, not news.
    and s.starts_at > now()
    and private.booking_email_switch(b.tenant_id, 'shop_cancel_email', true)
  on conflict on constraint booking_emails_booking_id_kind_session_id_key do nothing;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;
revoke all on function public.queue_booking_cancel_email(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.queue_booking_cancel_email(uuid, uuid) to service_role;

-- Gives a confirmed booking a new manage link, for sending the confirmation
-- again. Owners and admins only.
create function public.renew_booking_link(p_booking_id uuid, p_manage_token text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_booking public.bookings := private.manager_booking(p_booking_id);
begin
  if v_booking.status <> 'confirmed' then
    raise exception 'Booking not found' using errcode = 'P0002';
  end if;
  if char_length(coalesce(p_manage_token, '')) < 24 then
    raise exception 'Link too short' using errcode = '22023';
  end if;
  update public.bookings b set manage_token_hash = private.hash_token(p_manage_token)
  where b.id = v_booking.id;
end;
$$;
revoke all on function public.renew_booking_link(uuid, text) from public, anon;
grant execute on function public.renew_booking_link(uuid, text) to authenticated;
