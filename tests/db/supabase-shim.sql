-- Minimal stand-in for the parts of Supabase the migrations rely on, so the
-- real migration files can run against an in-process Postgres in tests.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

-- Supabase Vault, minus the encryption: same names and signatures, so the
-- migrations' Vault calls run unchanged. No role but the owner can touch it.
create schema vault;
create table vault.secrets (
  id uuid primary key default gen_random_uuid(),
  name text unique,
  description text not null default '',
  secret text not null
);
create view vault.decrypted_secrets as
  select id, name, description, secret, secret as decrypted_secret from vault.secrets;
create function vault.create_secret(
  new_secret text, new_name text default null, new_description text default '', new_key_id uuid default null
) returns uuid language sql as $$
  insert into vault.secrets (secret, name, description) values (new_secret, new_name, new_description)
  returning id;
$$;
create function vault.update_secret(
  secret_id uuid, new_secret text default null, new_name text default null,
  new_description text default null, new_key_id uuid default null
) returns void language sql as $$
  update vault.secrets s set
    secret = coalesce(new_secret, s.secret),
    name = coalesce(new_name, s.name),
    description = coalesce(new_description, s.description)
  where s.id = secret_id;
$$;
revoke all on function vault.create_secret(text, text, text, uuid) from public;
revoke all on function vault.update_secret(uuid, text, text, text, uuid) from public;

create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique
);

create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid;
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

-- Supabase grants broad table/function access in `public` by default; mirror
-- that so the tests prove the migrations lock things down themselves.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
