-- Help desk: who is answering an Instagram or Facebook conversation at Meta.
--
-- Meta lets one tool at a time answer a conversation ("thread control", part
-- of its Conversation Routing). A business that runs this suite beside
-- another inbox tool, or beside Meta's own inbox, can find a reply refused
-- because the other tool has the conversation. What we were told about that
-- is written on the person (one conversation per person per channel at Meta),
-- so the team can see it before writing. It is a note of what Meta said and
-- when: Meta decides, never this.

alter table public.contacts
  -- 'ours': Meta handed the conversation to this app, or took our reply.
  -- 'other': another tool had it the last time we heard. Null: never heard.
  add column thread_control text check (thread_control in ('ours', 'other')),
  -- The other tool's Meta app id, when Meta named it. Not a secret.
  add column thread_control_app text check (thread_control_app is null
    or thread_control_app ~ '^[0-9]{1,40}$'),
  add column thread_control_at timestamptz,
  add constraint contacts_thread_control_shape check (
    (thread_control is null) = (thread_control_at is null)
    and (thread_control_app is null or thread_control = 'other')
    and (thread_control is null or channel <> 'email')
  );

-- Writes down what Meta said about one person's conversation. Only ever for
-- someone we already know on that channel, and never backwards in time: Meta
-- delivers out of order. Returns whether anything was written.
create function public.note_thread_control(
  p_tenant_id uuid,
  p_channel text,
  p_external_id text,
  p_state text,
  p_app_id text default null,
  p_at timestamptz default now()
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_at timestamptz := least(coalesce(p_at, now()), now());
  v_rows int;
begin
  if p_state is null or p_state not in ('ours', 'other')
     or p_channel is null or p_channel not in ('instagram', 'facebook') then
    return false;
  end if;
  update public.contacts c
  set thread_control = p_state,
      thread_control_app = case
        when p_state = 'other' and p_app_id ~ '^[0-9]{1,40}$' then p_app_id end,
      thread_control_at = v_at
  where c.tenant_id = p_tenant_id
    and c.channel = p_channel
    and c.external_id = p_external_id
    and (c.thread_control_at is null or c.thread_control_at <= v_at);
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

revoke all on function public.note_thread_control(uuid, text, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.note_thread_control(uuid, text, text, text, text, timestamptz)
  to service_role;
