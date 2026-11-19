-- 0005_slots_and_api.sql
-- Phase 10: more than one post per day, a slot identity the rest of the schema can key on, and
-- hashed API keys + webhook deliveries for the OmniFlow integration.
--
-- Same rules as 0001-0004: `if not exists` / `drop ... if exists` guarded, so running the folder twice
-- is safe, and nothing here rewrites existing data destructively. The one column that has to change
-- meaning - generated_posts.run_date - keeps its name and gains a companion, so an older code path that
-- still says `run_date = '2026-11-18'` keeps working against a single-slot day.

-- ---------------------------------------------------------------------------------------------
-- 1. Settings: how many posts a day, and which times.
-- ---------------------------------------------------------------------------------------------
-- publish_times holds the wall-clock times of every slot ('10:30', '15:00', ...). generation_time
-- stays as the *first* slot's generation time, so a single-slot owner sees no change at all.
alter table public.app_settings
  add column if not exists publish_times text[] not null default '{}',
  add column if not exists posts_per_day smallint not null default 1;

alter table public.app_settings
  drop constraint if exists app_settings_posts_per_day_check;
alter table public.app_settings
  add constraint app_settings_posts_per_day_check check (posts_per_day between 1 and 5);

-- Backfill: an existing single-slot setup becomes a one-element list, so both representations agree.
update public.app_settings
   set publish_times = array[publish_time]
 where coalesce(array_length(publish_times, 1), 0) = 0;

-- ---------------------------------------------------------------------------------------------
-- 2. generated_posts: a slot index and a day-scoped uniqueness rule.
-- ---------------------------------------------------------------------------------------------
alter table public.generated_posts
  add column if not exists slot_index smallint not null default 0;

alter table public.generated_posts
  drop constraint if exists generated_posts_slot_index_check;
alter table public.generated_posts
  add constraint generated_posts_slot_index_check check (slot_index between 0 and 4);

-- One post per (day, slot). This replaces the implicit "one post per day" rule that used to live in
-- application code only - a race between two ticks could previously create two posts for one day.
create unique index if not exists generated_posts_date_slot_key
  on public.generated_posts (run_date, slot_index);

-- ---------------------------------------------------------------------------------------------
-- 3. content_topics: which slot a topic belongs to.
-- ---------------------------------------------------------------------------------------------
alter table public.content_topics
  add column if not exists slot_index smallint not null default 0;

alter table public.content_topics
  drop constraint if exists content_topics_slot_index_check;
alter table public.content_topics
  add constraint content_topics_slot_index_check check (slot_index between 0 and 4);

-- The claim query now filters by slot, so the index leads with it.
drop index if exists public.content_topics_claim_idx;
create index if not exists content_topics_claim_idx
  on public.content_topics (topic_date, slot_index, status, sheet_row_number, created_at);

-- ---------------------------------------------------------------------------------------------
-- 4. scheduler_state: a claim per (day, slot) instead of per day.
-- ---------------------------------------------------------------------------------------------
-- last_generation_date/attempts stay for the dashboard's "what happened today" view; the per-slot claim
-- is a separate table so two slots on the same day cannot block each other.
create table if not exists public.generation_claims (
  run_date date not null,
  slot_index smallint not null,
  attempts integer not null default 0,
  claimed_at timestamptz not null default now(),
  status text not null default 'claimed',
  updated_at timestamptz not null default now(),
  primary key (run_date, slot_index),
  constraint generation_claims_slot_check check (slot_index between 0 and 4),
  constraint generation_claims_attempts_non_negative check (attempts >= 0)
);

create index if not exists generation_claims_recent_idx
  on public.generation_claims (run_date desc, slot_index);

-- ---------------------------------------------------------------------------------------------
-- 5. OmniFlow: API keys (stored hashed) and webhook deliveries with retry state.
-- ---------------------------------------------------------------------------------------------
create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  -- sha256 hex of the key. The key itself is shown once, at creation, and never stored.
  key_hash text not null unique,
  -- first 8 characters, so the owner can tell two keys apart in the UI without the secret.
  key_prefix text not null default '',
  scopes text[] not null default '{read}',
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint api_keys_has_scopes check (array_length(scopes, 1) >= 1)
);

create index if not exists api_keys_active_idx
  on public.api_keys (key_hash) where revoked_at is null;

create table if not exists public.api_requests (
  id uuid primary key default gen_random_uuid(),
  api_key_id uuid references public.api_keys (id) on delete set null,
  method text not null,
  path text not null,
  status integer not null,
  duration_ms integer not null default 0,
  request_id text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists api_requests_recent_idx on public.api_requests (created_at desc);

create table if not exists public.webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  url text not null,
  -- HMAC-SHA256 signing secret. Stored as-is because the Worker needs it to sign every delivery;
  -- it is shown to the owner only when rotated.
  secret text not null,
  events text[] not null default '{}',
  active boolean not null default true,
  failure_count integer not null default 0,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint webhook_endpoints_https check (url like 'https://%' or url like 'http://localhost%')
);

create index if not exists webhook_endpoints_active_idx
  on public.webhook_endpoints (active) where active;

create table if not exists public.webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  endpoint_id uuid not null references public.webhook_endpoints (id) on delete cascade,
  event text not null,
  event_id text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  response_status integer,
  response_body text,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint webhook_deliveries_status_check check (
    status in ('pending', 'delivering', 'delivered', 'failed')
  )
);

-- One delivery row per (endpoint, event): a retried tick must not duplicate a webhook.
create unique index if not exists webhook_deliveries_event_key
  on public.webhook_deliveries (endpoint_id, event_id);

create index if not exists webhook_deliveries_due_idx
  on public.webhook_deliveries (status, next_attempt_at);

-- ---------------------------------------------------------------------------------------------
-- 6. Functions
-- ---------------------------------------------------------------------------------------------

-- Per-slot generation claim. Same contract as claim_generation_day, but keyed by (date, slot):
-- two slots of the same day can each be claimed exactly once.
create or replace function public.claim_generation_slot(
  p_date date,
  p_slot smallint,
  p_max_attempts integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempts integer;
begin
  insert into public.generation_claims (run_date, slot_index, attempts, status)
  values (p_date, p_slot, 1, 'claimed')
  on conflict (run_date, slot_index) do update
    set attempts = public.generation_claims.attempts + 1,
        claimed_at = now(),
        status = 'claimed',
        updated_at = now()
    where public.generation_claims.attempts < p_max_attempts
      and public.generation_claims.status in ('claimed', 'failed')
  returning attempts into v_attempts;

  if v_attempts is null then
    return false;
  end if;
  return true;
end;
$$;

-- Mark a slot's claim as finished so a failed slot can be retried and a succeeded one cannot.
create or replace function public.finish_generation_slot(
  p_date date,
  p_slot smallint,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.generation_claims
     set status = p_status,
         updated_at = now()
   where run_date = p_date
     and slot_index = p_slot;
end;
$$;

-- Claim a topic for a specific slot (defaults keep the old single-slot behaviour working).
create or replace function public.claim_daily_topic(
  p_date date,
  p_max_attempts integer,
  p_slot smallint default 0
)
returns setof public.content_topics
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.content_topics;
begin
  select *
    into v_row
    from public.content_topics
   where topic_date = p_date
     and slot_index = p_slot
     and (
       status = 'pending'
       or (status in ('failed', 'claimed') and attempts < p_max_attempts)
     )
   order by coalesce(sheet_row_number, 2147483647), created_at
   limit 1
     for update skip locked;

  if v_row.id is null then
    return;
  end if;

  update public.content_topics
     set status = 'claimed',
         attempts = attempts + 1,
         updated_at = now()
   where id = v_row.id
  returning * into v_row;

  return next v_row;
end;
$$;

-- Webhook backlog: the next batch of due deliveries, claimed atomically.
create or replace function public.claim_webhook_deliveries(p_limit integer)
returns setof public.webhook_deliveries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.webhook_deliveries;
begin
  for v_row in
    select *
      from public.webhook_deliveries
     where status = 'pending'
       and next_attempt_at <= now()
     order by next_attempt_at
     limit p_limit
       for update skip locked
  loop
    update public.webhook_deliveries
       set status = 'delivering',
           attempts = attempts + 1,
           updated_at = now()
     where id = v_row.id
    returning * into v_row;
    return next v_row;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 7. Triggers and security (same posture as every other table: RLS on, no anon grants)
-- ---------------------------------------------------------------------------------------------
drop trigger if exists generation_claims_set_updated_at on public.generation_claims;
create trigger generation_claims_set_updated_at
  before update on public.generation_claims
  for each row execute function public.set_updated_at();

drop trigger if exists api_keys_set_updated_at on public.api_keys;
create trigger api_keys_set_updated_at
  before update on public.api_keys
  for each row execute function public.set_updated_at();

drop trigger if exists webhook_endpoints_set_updated_at on public.webhook_endpoints;
create trigger webhook_endpoints_set_updated_at
  before update on public.webhook_endpoints
  for each row execute function public.set_updated_at();

drop trigger if exists webhook_deliveries_set_updated_at on public.webhook_deliveries;
create trigger webhook_deliveries_set_updated_at
  before update on public.webhook_deliveries
  for each row execute function public.set_updated_at();

alter table public.generation_claims enable row level security;
alter table public.api_keys enable row level security;
alter table public.api_requests enable row level security;
alter table public.webhook_endpoints enable row level security;
alter table public.webhook_deliveries enable row level security;

-- The Worker runs as service_role; browser roles get nothing (see docs/ARCHITECTURE.md).
grant select, insert, update, delete on public.generation_claims to service_role;
grant select, insert, update, delete on public.api_keys to service_role;
grant select, insert, update, delete on public.api_requests to service_role;
grant select, insert, update, delete on public.webhook_endpoints to service_role;
grant select, insert, update, delete on public.webhook_deliveries to service_role;

revoke all on public.generation_claims from anon, authenticated;
revoke all on public.api_keys from anon, authenticated;
revoke all on public.api_requests from anon, authenticated;
revoke all on public.webhook_endpoints from anon, authenticated;
revoke all on public.webhook_deliveries from anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 8. Web push subscriptions (PWA). One row per browser/device endpoint.
-- ---------------------------------------------------------------------------------------------
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  failure_count integer not null default 0,
  last_success_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint push_subscriptions_failure_count_non_negative check (failure_count >= 0)
);

create index if not exists push_subscriptions_healthy_idx
  on public.push_subscriptions (failure_count) where failure_count < 5;

drop trigger if exists push_subscriptions_set_updated_at on public.push_subscriptions;
create trigger push_subscriptions_set_updated_at
  before update on public.push_subscriptions
  for each row execute function public.set_updated_at();

alter table public.push_subscriptions enable row level security;
grant select, insert, update, delete on public.push_subscriptions to service_role;
revoke all on public.push_subscriptions from anon, authenticated;
