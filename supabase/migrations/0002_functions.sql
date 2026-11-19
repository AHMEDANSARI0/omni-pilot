-- 0002_functions.sql
-- Phase 8 (migration recovery): the eight RPCs the Worker calls. Each one replaces a read-then-
-- write pair in application code with a single atomic statement, which is what makes two
-- concurrent cron ticks safe (docs/ARCHITECTURE.md, "Idempotency and duplicate prevention").
--
-- Return shapes match `src/adapters/db/postgrest.ts` exactly (it maps rows, not envelopes), and
-- the behaviour matches `src/adapters/db/memory.ts` so the local database and Supabase can never
-- drift apart. Every function is `security definer` + `search_path = ''` guarded, and execute is
-- granted to service_role only.

-- ---------------------------------------------------------------------------------------------
-- claim_generation_day(p_date, p_max_attempts) -> boolean
--   True only for the tick that wins the day. A day that already succeeded never returns true;
--   a day that failed returns true until attempts reach p_max_attempts.
-- ---------------------------------------------------------------------------------------------

create or replace function public.claim_generation_day(p_date date, p_max_attempts integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed boolean := false;
begin
  insert into public.scheduler_state (id) values (true) on conflict (id) do nothing;

  update public.scheduler_state
     set last_generation_date = p_date,
         last_generation_at = now(),
         last_generation_status = 'running',
         generation_attempts = case
           when last_generation_date = p_date then generation_attempts + 1
           else 1
         end
   where id
     -- `is distinct from` instead of `=` so a NULL last_generation_date (fresh row) counts as a
     -- different day. A plain comparison would evaluate to NULL and silently claim nothing.
     and not (last_generation_date is not distinct from p_date
              and last_generation_status = 'succeeded')
     and not (last_generation_date is not distinct from p_date
              and generation_attempts >= p_max_attempts)
  returning true into claimed;

  return coalesce(claimed, false);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- claim_daily_topic(p_date, p_max_attempts) -> content_topics row (0 or 1 row)
--   Picks the earliest claimable topic for a date and marks it `claimed` in one statement.
--   FOR UPDATE SKIP LOCKED means two workers never take the same row.
-- ---------------------------------------------------------------------------------------------

create or replace function public.claim_daily_topic(p_date date, p_max_attempts integer)
returns setof public.content_topics
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with candidate as (
    select t.id
      from public.content_topics t
     where t.topic_date = p_date
       and (
         t.status = 'pending'
         or (t.status = 'failed' and t.attempts < p_max_attempts)
         or (t.status = 'claimed' and t.attempts < p_max_attempts)
       )
     order by coalesce(t.sheet_row_number, 2147483647), t.created_at
     limit 1
     for update skip locked
  )
  update public.content_topics t
     set status = 'claimed',
         attempts = t.attempts + 1
    from candidate c
   where t.id = c.id
  returning t.*;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- claim_post_for_publish(p_post_id) -> generated_posts row (0 or 1 row)
--   approved -> publishing, atomically. A post that is already publishing or published cannot
--   be claimed again, so a second worker publishes nothing.
-- ---------------------------------------------------------------------------------------------

create or replace function public.claim_post_for_publish(p_post_id uuid)
returns setof public.generated_posts
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  update public.generated_posts p
     set status = 'publishing'
   where p.id = p_post_id
     and p.status = 'approved'
  returning p.*;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- claim_publishing_jobs(p_limit) -> publishing_jobs rows
--   Queued + due + not locked jobs become `processing` for 10 minutes. Expired locks are
--   reclaimable immediately (that is the crash recovery path together with recover_stuck_jobs).
-- ---------------------------------------------------------------------------------------------

create or replace function public.claim_publishing_jobs(p_limit integer)
returns setof public.publishing_jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with due as (
    select j.id
      from public.publishing_jobs j
     where j.status = 'queued'
       and j.run_at <= now()
       and (j.locked_until is null or j.locked_until < now())
     order by j.run_at
     limit greatest(coalesce(p_limit, 1), 1)
     for update skip locked
  )
  update public.publishing_jobs j
     set status = 'processing',
         attempts = j.attempts + 1,
         locked_until = now() + interval '10 minutes',
         last_error = null
    from due
   where j.id = due.id
  returning j.*;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- recover_stuck_jobs() -> integer (jobs returned to the queue)
--   A `processing` job whose lock is more than a minute old goes back to `queued` and is due
--   now. Posts left in `publishing` with no live job go back to `approved` (published_at IS NULL
--   only) so they can be retried instead of hanging forever.
-- ---------------------------------------------------------------------------------------------

create or replace function public.recover_stuck_jobs()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  recovered integer := 0;
begin
  update public.publishing_jobs j
     set status = 'queued',
         locked_until = null,
         run_at = now()
   where j.status = 'processing'
     and j.locked_until is not null
     and j.locked_until < now() - interval '1 minute';
  get diagnostics recovered = row_count;

  update public.generated_posts p
     set status = 'approved'
   where p.status = 'publishing'
     and p.published_at is null
     and not exists (
       select 1 from public.publishing_jobs j
        where j.post_id = p.id and j.status = 'processing'
     );

  return recovered;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- consume_approval(p_token_hash, p_action) -> approval_requests row (0 or 1 row)
--   Single use: only a pending, unexpired token is consumed, and only with a valid action.
--   A replayed link returns no row, which the app treats as "already used".
-- ---------------------------------------------------------------------------------------------

create or replace function public.consume_approval(p_token_hash text, p_action text)
returns setof public.approval_requests
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_action not in ('approve', 'reject') then
    raise exception 'consume_approval: invalid action %', p_action
      using errcode = '22023';
  end if;

  return query
  update public.approval_requests a
     set status = case when p_action = 'approve' then 'approved' else 'rejected' end,
         action = p_action,
         used_at = now()
   where a.token_hash = p_token_hash
     and a.status = 'pending'
     and a.expires_at > now()
  returning a.*;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- expire_stale_approvals() -> { expired_approvals, expired_posts }
--   Pending approvals past their TTL become `expired`; their posts move pending_approval ->
--   expired only if nothing else already decided them.
-- ---------------------------------------------------------------------------------------------

create or replace function public.expire_stale_approvals()
returns table (expired_approvals integer, expired_posts integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  approval_count integer := 0;
  post_count integer := 0;
begin
  with stale as (
    update public.approval_requests a
       set status = 'expired'
     where a.status = 'pending'
       and a.expires_at <= now()
    returning a.post_id
  )
  select count(*) into approval_count from stale;

  with targets as (
    select p.id
      from public.generated_posts p
     where p.status = 'pending_approval'
       and exists (
         select 1 from public.approval_requests a
          where a.post_id = p.id and a.status = 'expired'
       )
  )
  update public.generated_posts p
     set status = 'expired'
    from targets t
   where p.id = t.id
     and p.status = 'pending_approval';
  get diagnostics post_count = row_count;

  return query select approval_count, post_count;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- prune_whatsapp_artifacts(p_code_days, p_message_days) -> integer (rows removed)
--   Housekeeping for the WhatsApp tables: used/expired codes and old inbound message ids.
--   Defaults keep a week of codes and a month of dedupe ids.
-- ---------------------------------------------------------------------------------------------

create or replace function public.prune_whatsapp_artifacts(
  p_code_days integer default 7,
  p_message_days integer default 30
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed integer := 0;
  deleted integer := 0;
begin
  delete from public.whatsapp_approval_codes c
   where c.expires_at < now() - make_interval(days => greatest(coalesce(p_code_days, 7), 0));
  get diagnostics deleted = row_count;
  removed := removed + deleted;

  delete from public.whatsapp_messages m
   where m.received_at < now() - make_interval(days => greatest(coalesce(p_message_days, 30), 0));
  get diagnostics deleted = row_count;
  removed := removed + deleted;

  return removed;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Execute is for the service role only: these functions bypass RLS by design.
-- ---------------------------------------------------------------------------------------------

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.claim_generation_day(date, integer)',
    'public.claim_daily_topic(date, integer)',
    'public.claim_post_for_publish(uuid)',
    'public.claim_publishing_jobs(integer)',
    'public.recover_stuck_jobs()',
    'public.consume_approval(text, text)',
    'public.expire_stale_approvals()',
    'public.prune_whatsapp_artifacts(integer, integer)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
