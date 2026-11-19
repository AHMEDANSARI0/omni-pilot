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
  it('ships all four migrations', () => {
    expect(migrationFiles).toEqual([
      '0001_schema.sql',
      '0002_functions.sql',
      '0003_whatsapp.sql',
      '0004_post_variants.sql',
    ]);
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
      expect(direct.test(sql) || looped.test(sql), `${table}: no service_role grant`).toBe(true);
    }
    // No statement in the folder may grant to the browser-facing roles.
    expect(/grant\b[^;]*\bto\b[^;]*\b(anon|authenticated)\b/i.test(sql)).toBe(false);
  });

  it('keeps the one-row-per-day and one-job-per-post guards in SQL', () => {
    expect(sql).toMatch(/create unique index if not exists generated_posts_run_date_key/);
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
