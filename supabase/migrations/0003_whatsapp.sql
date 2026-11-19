-- 0003_whatsapp.sql
-- Phase 8 (migration recovery): WhatsApp approval storage.
--
-- Two tables only:
--   whatsapp_approval_codes - the short APR-XXXXXX code shown in the approval email. Stored
--                             hashed, single use, short TTL, one row per issued code.
--   whatsapp_messages       - inbound message ids, so a Meta webhook retry is processed once.
--
-- No message bodies and no phone numbers beyond the sender are stored; see docs/WHATSAPP.md.
-- Idempotent: safe to run again on an existing project.

create table if not exists public.whatsapp_approval_codes (
  code_hash text primary key,
  post_id uuid not null references public.generated_posts (id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint whatsapp_approval_codes_hash_not_blank check (length(code_hash) > 0)
);

create index if not exists whatsapp_approval_codes_post_idx
  on public.whatsapp_approval_codes (post_id);
-- consumeWhatsAppCode filters on used_at is null and expires_at > now().
create index if not exists whatsapp_approval_codes_live_idx
  on public.whatsapp_approval_codes (expires_at) where used_at is null;

create table if not exists public.whatsapp_messages (
  message_id text primary key,
  from_number text not null,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint whatsapp_messages_id_not_blank check (length(message_id) > 0)
);

-- prune_whatsapp_artifacts() deletes by age.
create index if not exists whatsapp_messages_received_idx on public.whatsapp_messages (received_at);

do $$
declare
  target_table text;
begin
  foreach target_table in array array['whatsapp_approval_codes', 'whatsapp_messages'] loop
    execute format('alter table public.%I enable row level security', target_table);
    execute format('revoke all on public.%I from anon, authenticated', target_table);
    execute format('grant all on public.%I to service_role', target_table);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
