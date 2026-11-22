-- Members could see that a connection exists but not its details, so the
-- screens that ask "is Instagram linked?", "can Stripe take payments yet?"
-- or "which permissions did the shop give?" got no answer at all. The
-- details hold nothing secret (tokens live in Vault): a currency, an
-- Instagram handle, whether Stripe is ready.
grant select (metadata) on public.connections to authenticated;
