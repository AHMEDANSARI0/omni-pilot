-- 0001_schema.sql
-- Phase 8 (migration recovery): the base schema this app actually uses.
--
-- Reconstructed from the running code, not from memory: every table, column name, nullability,
-- default, unique constraint and index below is what `src/adapters/db/postgrest.ts` already
-- queries, and what `src/adapters/db/memory.ts` already does in memory. Functions live in
-- 0002_functions.sql, WhatsApp in 0003_whatsapp.sql, draft options in 0004_post_variants.sql.
--
-- Everything is `if not exists` / `drop ... if exists` guarded, so running the whole folder
-- twice is safe (idempotent, like every phase patch).
--
-- Security model (see docs/ARCHITECTURE.md): the browser never touches this database. The
-- Worker uses the service role; `anon` and `authenticated` get no grants at all, and RLS is on
-- every table so a leaked anon key still reads nothing.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------------------------

-- updated_at is maintained by trigger, so a PostgREST PATCH cannot forget it.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 1. app_settings - one row, id is forced true so the unique index makes a second row impossible.
-- ---------------------------------------------------------------------------------------------

create table if not exists public.app_settings (
  id boolean primary key default true,
  owner_timezone text not null default 'Asia/Karachi',
  -- generation/publish times are text 'HH:MM' because that is how the UI and the scheduler
  -- both read them (shortTime() in the adapter).
  generation_time text not null default '08:00',
  publish_time text not null default '10:30',
  publish_days smallint[] not null default '{1,2,3,4,5}',
  respect_publish_time boolean not null default true,
  auto_publish_on_approval boolean not null default false,
  approval_ttl_hours integer not null default 48,
  ai_provider text not null default 'gemini',
  ai_model text not null default 'gemini-2.5-flash',
  brand_voice text not null default '',
  writing_instructions text not null default '',
  hashtag_min integer not null default 3,
  hashtag_max integer not null default 5,
  max_post_chars integer not null default 2800,
  email_notifications boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_settings_single_row check (id),
  constraint app_settings_hashtags check (hashtag_min >= 0 and hashtag_max >= hashtag_min),
  constraint app_settings_max_chars check (max_post_chars between 200 and 3000),
  constraint app_settings_ttl check (approval_ttl_hours between 1 and 720)
);

-- ---------------------------------------------------------------------------------------------
-- 2. content_topics - one row per planned topic (sheet import or dashboard entry).
-- ---------------------------------------------------------------------------------------------

create table if not exists public.content_topics (
  id uuid primary key default gen_random_uuid(),
  sheet_row_number integer,
  topic_date date not null,
  topic text not null,
  content_type text not null default 'insight',
  key_points text,
  target_audience text,
  status text not null default 'pending',
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint content_topics_status_check
    check (status in ('pending', 'claimed', 'generated', 'skipped', 'failed')),
  constraint content_topics_topic_not_blank check (length(btrim(topic)) > 0),
  constraint content_topics_attempts_non_negative check (attempts >= 0)
);

-- Sheet rows are imported twice on a re-sync; ON CONFLICT (topic_date, topic) DO NOTHING needs this.
create unique index if not exists content_topics_date_topic_key
  on public.content_topics (topic_date, topic);
-- Claim query: the earliest pending topic for a date, by sheet row then age.
create index if not exists content_topics_claim_idx
  on public.content_topics (topic_date, status, sheet_row_number, created_at);
create index if not exists content_topics_status_idx on public.content_topics (status);

-- ---------------------------------------------------------------------------------------------
-- 3. generated_posts - the single source of truth for approvals and publishing.
-- ---------------------------------------------------------------------------------------------

create table if not exists public.generated_posts (
  id uuid primary key default gen_random_uuid(),
  topic_id uuid references public.content_topics (id) on delete set null,
  run_date date not null,
  hook text not null,
  body text not null,
  hashtags text[] not null default '{}',
  full_text text not null,
  char_count integer not null default 0,
  provider text not null default '',
  model text not null default '',
  status text not null default 'pending_approval',
  source text not null default 'ai',
  edited_by_owner boolean not null default false,
  error_message text,
  external_id text,
  published_url text,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint generated_posts_status_check check (
    status in (
      'draft', 'pending_approval', 'approved', 'rejected',
      'expired', 'publishing', 'published', 'failed'
    )
  ),
  constraint generated_posts_char_count_non_negative check (char_count >= 0)
);

-- One post per day: this is the guard behind "no duplicate post for the same run_date".
create unique index if not exists generated_posts_run_date_key on public.generated_posts (run_date);
create index if not exists generated_posts_status_idx on public.generated_posts (status, run_date desc);
create index if not exists generated_posts_topic_idx on public.generated_posts (topic_id);

-- ---------------------------------------------------------------------------------------------
-- 4. approval_requests - one row per approval email/WhatsApp message.
-- ---------------------------------------------------------------------------------------------

create table if not exists public.approval_requests (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.generated_posts (id) on delete cascade,
  token_hash text not null,
  status text not null default 'pending',
  action text,
  expires_at timestamptz not null,
  used_at timestamptz,
  email_sent_at timestamptz,
  email_message_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint approval_requests_status_check
    check (status in ('pending', 'approved', 'rejected', 'expired')),
  constraint approval_requests_action_check
    check (action is null or action in ('approve', 'reject'))
);

create unique index if not exists approval_requests_token_hash_key
  on public.approval_requests (token_hash);
-- Latest active approval for a post (getActiveApprovalForPost).
create index if not exists approval_requests_post_idx
  on public.approval_requests (post_id, status, created_at desc);
create index if not exists approval_requests_expiry_idx
  on public.approval_requests (expires_at) where status = 'pending';

-- ---------------------------------------------------------------------------------------------
-- 5. publishing_jobs - one job per post (UNIQUE post_id makes double publishing impossible).
-- ---------------------------------------------------------------------------------------------

create table if not exists public.publishing_jobs (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.generated_posts (id) on delete cascade,
  run_at timestamptz not null default now(),
  status text not null default 'queued',
  attempts integer not null default 0,
  locked_until timestamptz,
  last_error text,
  external_id text,
  post_url text,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint publishing_jobs_status_check check (
    status in ('queued', 'processing', 'published', 'failed', 'manual_required', 'canceled')
  ),
  constraint publishing_jobs_attempts_non_negative check (attempts >= 0)
);

create unique index if not exists publishing_jobs_post_id_key on public.publishing_jobs (post_id);
-- claim_publishing_jobs scans this partial index only.
create index if not exists publishing_jobs_due_idx
  on public.publishing_jobs (run_at) where status = 'queued';
create index if not exists publishing_jobs_status_idx on public.publishing_jobs (status, created_at desc);

-- ---------------------------------------------------------------------------------------------
-- 6. integrations - one row per provider; tokens are AES-GCM encrypted before they land here.
-- ---------------------------------------------------------------------------------------------

create table if not exists public.integrations (
  provider text primary key,
  status text not null default 'disconnected',
  account_label text,
  scopes text[] not null default '{}',
  access_token_enc text,
  refresh_token_enc text,
  token_expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  last_checked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint integrations_provider_check
    check (provider in ('google_sheets', 'linkedin', 'resend', 'gemini')),
  constraint integrations_status_check
    check (status in ('connected', 'disconnected', 'error', 'needs_reauth'))
);

-- ---------------------------------------------------------------------------------------------
-- 7. oauth_states - single-use CSRF state for the Google/LinkedIn OAuth round trip.
-- ---------------------------------------------------------------------------------------------

create table if not exists public.oauth_states (
  state text primary key,
  provider text not null,
  redirect_after text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists oauth_states_expiry_idx on public.oauth_states (expires_at);

-- ---------------------------------------------------------------------------------------------
-- 8. execution_logs - append-only audit trail (redacted context, never tokens).
-- ---------------------------------------------------------------------------------------------

create table if not exists public.execution_logs (
  id bigint generated always as identity primary key,
  run_id text,
  level text not null default 'info',
  event text not null,
  message text,
  context jsonb not null default '{}'::jsonb,
  actor text not null default 'system',
  created_at timestamptz not null default now(),
  constraint execution_logs_level_check check (level in ('debug', 'info', 'warn', 'error'))
);

create index if not exists execution_logs_created_idx on public.execution_logs (created_at desc);
create index if not exists execution_logs_event_idx on public.execution_logs (event, created_at desc);
create index if not exists execution_logs_level_idx on public.execution_logs (level, created_at desc);
create index if not exists execution_logs_run_idx on public.execution_logs (run_id);

-- ---------------------------------------------------------------------------------------------
-- 9. scheduler_state - one row; every cron tick and "run now" goes through claim_generation_day.
-- ---------------------------------------------------------------------------------------------

create table if not exists public.scheduler_state (
  id boolean primary key default true,
  last_generation_date date,
  last_generation_at timestamptz,
  last_generation_status text,
  generation_attempts integer not null default 0,
  last_publish_sweep_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint scheduler_state_single_row check (id),
  constraint scheduler_state_generation_attempts_non_negative check (generation_attempts >= 0)
);

-- ---------------------------------------------------------------------------------------------
-- updated_at triggers (skip whatsapp_messages, which is insert-only and has no updated_at).
-- ---------------------------------------------------------------------------------------------

drop trigger if exists app_settings_set_updated_at on public.app_settings;
create trigger app_settings_set_updated_at before update on public.app_settings
  for each row execute function public.set_updated_at();

drop trigger if exists content_topics_set_updated_at on public.content_topics;
create trigger content_topics_set_updated_at before update on public.content_topics
  for each row execute function public.set_updated_at();

drop trigger if exists generated_posts_set_updated_at on public.generated_posts;
create trigger generated_posts_set_updated_at before update on public.generated_posts
  for each row execute function public.set_updated_at();

drop trigger if exists approval_requests_set_updated_at on public.approval_requests;
create trigger approval_requests_set_updated_at before update on public.approval_requests
  for each row execute function public.set_updated_at();

drop trigger if exists publishing_jobs_set_updated_at on public.publishing_jobs;
create trigger publishing_jobs_set_updated_at before update on public.publishing_jobs
  for each row execute function public.set_updated_at();

drop trigger if exists integrations_set_updated_at on public.integrations;
create trigger integrations_set_updated_at before update on public.integrations
  for each row execute function public.set_updated_at();

drop trigger if exists scheduler_state_set_updated_at on public.scheduler_state;
create trigger scheduler_state_set_updated_at before update on public.scheduler_state
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Singletons: the app reads `id=eq.true` and falls back to defaults when the row is missing,
-- but a real deploy should start with a row, so insert one if the table is empty.
-- ---------------------------------------------------------------------------------------------

insert into public.app_settings (id) values (true) on conflict (id) do nothing;
insert into public.scheduler_state (id) values (true) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------------------------
-- Privileges + RLS: service role only. No policies are created on purpose - with RLS enabled
-- and no policy, `anon`/`authenticated` read and write nothing, while the service role
-- (which bypasses RLS) keeps working.
-- ---------------------------------------------------------------------------------------------

do $$
declare
  target_table text;
begin
  foreach target_table in array array[
    'app_settings', 'content_topics', 'generated_posts', 'approval_requests',
    'publishing_jobs', 'integrations', 'oauth_states', 'execution_logs', 'scheduler_state'
  ] loop
    execute format('alter table public.%I enable row level security', target_table);
    execute format('revoke all on public.%I from anon, authenticated', target_table);
    execute format('grant all on public.%I to service_role', target_table);
  end loop;
end;
$$;

-- PostgREST must see the new tables straight away.
notify pgrst, 'reload schema';
