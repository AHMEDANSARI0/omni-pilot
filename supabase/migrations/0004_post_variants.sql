-- 0004_post_variants.sql
-- Phase 4: three draft options per generation run (one AI request, not three).
--
-- generated_posts stays the single source of truth for approvals and publishing; a row here is
-- one of the options that produced it. Exactly one option is "selected" and its text is what the
-- post holds. Discarded options are pruned by the scheduler after 24h.

create table if not exists public.post_variants (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.generated_posts (id) on delete cascade,
  variant_index integer not null,
  angle text not null default '',
  hook text not null,
  body text not null,
  hashtags text[] not null default '{}',
  full_text text not null,
  char_count integer not null default 0,
  selected boolean not null default false,
  discarded_at timestamptz,
  created_at timestamptz not null default now(),
  constraint post_variants_post_index_unique unique (post_id, variant_index)
);

create index if not exists post_variants_post_idx on public.post_variants (post_id);
create index if not exists post_variants_discarded_idx on public.post_variants (discarded_at);

-- Service-role only, like every other table in this schema.
alter table public.post_variants enable row level security;
