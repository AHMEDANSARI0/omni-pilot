import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Drift guard: the SQL folder and the PostgREST adapter must describe the same database.
 *
 * These tests need no database. They read the migrations and the adapter source and fail when one
 * side moves without the other, which is exactly how 0001-0003 went missing in the first place.
 */
const root = process.cwd();
const migrationsDir = join(root, 'supabase', 'migrations');

const migrationFiles = readdirSync(migrationsDir)
  .filter((name) => name.endsWith('.sql'))
  .sort();

const sql = migrationFiles
  .map((name) => readFileSync(join(migrationsDir, name), 'utf8'))
  .join('\n');

const adapter = readFileSync(join(root, 'src', 'adapters', 'db', 'postgrest.ts'), 'utf8');

/** Table names the adapter actually talks to, in call order, de-duplicated. */
function adapterTables(): string[] {
  const names = new Set<string>();
  const call = /this\.client\.(?:select|insert|update|remove|count)(?:<[^>]*>)?\(\s*'([a-z_]+)'/g;
  for (const match of adapter.matchAll(call)) names.add(match[1]!);
  return [...names].sort();
}

/** RPC names the adapter actually calls. */
function adapterRpcs(): string[] {
  const names = new Set<string>();
  const call = /\.rpc(?:<[^>]*>)?\(\s*'([a-z_]+)'/g;
  for (const match of adapter.matchAll(call)) names.add(match[1]!);
  return [...names].sort();
}

function createdTables(): string[] {
  const names = new Set<string>();
  const create = /create table if not exists public\.([a-z_]+)/g;
  for (const match of sql.matchAll(create)) names.add(match[1]!);
  return [...names].sort();
}

function createdFunctions(): string[] {
  const names = new Set<string>();
  const create = /create or replace function public\.([a-z_]+)/g;
  for (const match of sql.matchAll(create)) names.add(match[1]!);
  return [...names].sort();
}

describe('Migrations match the adapter', () => {
  /**
   * The list is not spelled out here on purpose.
   *
   * This test used to compare against a hand-written array, so *every* new migration broke it - and it broke in
   * the one place that was supposed to keep the SQL honest. What actually matters is the naming contract:
   * numbered files, no gaps, applied in order, every one of them reachable from `setup.sql`. A new migration
   * that follows the contract needs no edit here; one that breaks it fails, which is the point.
   */
  it('numbers the migrations without gaps, and every one is in setup.sql', () => {
    expect(migrationFiles.length).toBeGreaterThanOrEqual(5);
    const numbers = migrationFiles.map((name) => Number(name.slice(0, 4)));
    // 0001, 0002, ... with no holes: a gap means a file was renamed or lost.
    numbers.forEach((value, index) => {
      expect(Number.isInteger(value), `${migrationFiles[index]} does not start with a 4-digit number`).toBe(true);
      expect(value).toBe(index + 1);
    });
    expect(migrationFiles.every((name) => name.endsWith('.sql'))).toBe(true);

    // A migration that nobody can run is worse than no migration: setup.sql is the one-paste path.
    const setup = readFileSync(join(root, 'supabase', 'setup.sql'), 'utf8');
    for (const file of migrationFiles) {
      expect(setup.includes(file), `supabase/setup.sql does not include ${file} (run tools/build-setup-sql.mjs)`).toBe(
        true,
      );
    }
  });

  it('creates every table the PostgREST adapter queries', () => {
    const tables = adapterTables();
    // The regex has to find something, otherwise this test would pass on an empty list.
    expect(tables.length).toBeGreaterThanOrEqual(10);
    expect(tables).toContain('generated_posts');
    expect(tables).toContain('post_variants');
    expect(createdTables()).toEqual(expect.arrayContaining(tables));
  });

  it('creates every RPC the PostgREST adapter calls', () => {
    const rpcs = adapterRpcs();
    expect(rpcs.length).toBeGreaterThanOrEqual(6);
    expect(createdFunctions()).toEqual(expect.arrayContaining(rpcs));
  });

  it('enables row level security on every table it creates', () => {
    for (const table of createdTables()) {
      // 0001 and 0003 enable RLS inside a `foreach ... execute format(...)` loop, so match the name
      // inside that array as well as a plain statement.
      const direct = new RegExp(`alter table public\\.${table}\\s+enable row level security`);
      const looped = new RegExp(`'${table}'`);
      expect(direct.test(sql) || looped.test(sql), `${table} has no RLS`).toBe(true);
    }
  });

  it('grants the service role and never anon/authenticated', () => {
    for (const table of createdTables()) {
      // 0001/0003 grant inside `execute format('grant all on public.%I to service_role', ...)`.
      const direct = new RegExp(`grant all on public\\.${table}\\b`);
      const looped = new RegExp(`'${table}'`);
      expect(
        direct.test(sql) || looped.test(sql),
        `${table}: no service_role grant`,
      ).toBe(true);
    }
    // No statement in the folder may grant to the browser-facing roles.
    expect(/grant\b[^;]*\bto\b[^;]*\b(anon|authenticated)\b/i.test(sql)).toBe(false);
  });

  it('keeps the one-post-per-(day, slot) and one-job-per-post guards in SQL', () => {
    // Phase 10 replaced the implicit one-post-per-day rule with an explicit slot identity: the unique
    // index is what stops two ticks creating two posts for the same slot.
    expect(sql).toMatch(/create unique index if not exists generated_posts_date_slot_key/);
    expect(sql).toMatch(/create unique index if not exists publishing_jobs_post_id_key/);
    expect(sql).toMatch(/create unique index if not exists content_topics_date_topic_key/);
    expect(sql).toMatch(/create unique index if not exists approval_requests_token_hash_key/);
  });

  it('stays idempotent: no bare create table/index/function', () => {
    expect(/create table (?!if not exists)/i.test(sql)).toBe(false);
    expect(/create (unique )?index (?!if not exists)/i.test(sql)).toBe(false);
    expect(/create or replace function/i.test(sql)).toBe(true);
    expect(/create (?!or replace )function/i.test(sql)).toBe(false);
  });

  it('documents the same file list the database page prints', () => {
    const setup = readFileSync(join(root, 'docs', 'SETUP.md'), 'utf8');
    for (const file of migrationFiles) {
      expect(setup.includes(file), `docs/SETUP.md does not mention ${file}`).toBe(true);
    }
  });
});
