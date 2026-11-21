#!/usr/bin/env node
/**
 * Applies a migration file to Supabase without the CLI.
 *
 *   node scripts/db-push.mjs                     apply any migration this database has not seen
 *   node scripts/db-push.mjs --dry-run           show what would run, touch nothing
 *   node scripts/db-push.mjs --file supabase/migrations/0005_slots_and_api.sql
 *   node scripts/db-push.mjs --status            list applied migrations
 *
 * Why this exists. `supabase db push` needs the Supabase CLI, which is a separate install and is not on
 * PATH on most Windows machines (`'supabase' is not recognized as an internal or external command`). The
 * dashboard SQL editor works but has no record of what has run. This script covers the middle: it talks
 * to the same Postgres over Supabase's `pg` endpoint, keeps a `schema_migrations` table so runs are
 * idempotent and auditable, and prints exactly what it did.
 *
 * Credentials come from the environment or `.env.local`:
 *
 *   SUPABASE_URL=https://<ref>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY=<service-role-key>      (or SUPABASE_DB_URL=<postgres connection string>)
 *
 * Security: this runs DDL, so it needs the service role key. It never prints the key, and it refuses to
 * run against a URL that does not look like Supabase unless `--allow-any-host` is passed.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations');
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const statusOnly = argv.includes('--status');
const allowAnyHost = argv.includes('--allow-any-host');
const fileFlag = argv.indexOf('--file');
const onlyFile = fileFlag === -1 ? null : argv[fileFlag + 1];

const paint = (code, text) =>
  process.stdout.isTTY && !process.env.NO_COLOR ? `\u001b[${code}m${text}\u001b[0m` : text;
const ok = (text) => console.log(`  ${paint(32, 'ok  ')} ${text}`);
const info = (text) => console.log(`  ${paint(90, 'info')} ${text}`);
const fail = (text) => console.log(`  ${paint(31, 'FAIL')} ${text}`);

/* ------------------------------------------------------------------ config */

function loadLocalEnv() {
  for (const file of ['.env.local', '.env']) {
    const path = join(ROOT, file);
    if (!existsSync(path)) continue;
    try {
      process.loadEnvFile(path);
    } catch {
      return;
    }
    if (process.env.SUPABASE_DB_URL || process.env.SUPABASE_URL) return;
  }
}

loadLocalEnv();

const projectUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const dbUrl = process.env.SUPABASE_DB_URL;

/**
 * The connection string this script will use.
 *
 * `SUPABASE_DB_URL` wins when present (it is the only way to run multi-statement SQL over the pooler).
 * Otherwise the project URL is turned into the standard Supavisor connection string; the password half
 * of it still has to come from somewhere, which is why the message below is explicit about it.
 */
function connection() {
  if (dbUrl) return dbUrl;
  if (!projectUrl) return null;
  // postgres://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
  // The region is not derivable from the project URL, so it must be supplied.
  const ref = /^https?:\/\/([a-z0-9]+)\.supabase\.co/i.exec(projectUrl)?.[1];
  const region = process.env.SUPABASE_DB_REGION;
  const password = process.env.SUPABASE_DB_PASSWORD;
  if (!ref || !region || !password) return null;
  return `postgres://postgres.${ref}:${encodeURIComponent(password)}@aws-0-${region}.pooler.supabase.com:5432/postgres`;
}

const url = connection();

if (!url) {
  fail('no database connection configured.');
  console.log(`
  Two ways to apply a migration; pick whichever matches your setup.

  A) Dashboard (no install, works everywhere) — recommended if you do not have the CLI:
     1. Open your project -> SQL Editor -> New query.
     2. Paste the whole of supabase/migrations/0005_slots_and_api.sql
     3. Run. It is idempotent: every statement is "if not exists" / "create or replace".
     4. Then run: npm run db:verify

  B) This script (needs a Postgres connection string):
     Add to .env.local:

       SUPABASE_DB_URL=postgres://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres

     The password is the database password from Project Settings -> Database.
     Then: node scripts/db-push.mjs --dry-run
           node scripts/db-push.mjs
`);
  process.exit(1);
}

if (!/supabase|pooler|postgres/i.test(url) && !allowAnyHost) {
  fail('the connection string does not look like a Supabase/Postgres host.');
  info('pass --allow-any-host if you really mean it');
  process.exit(1);
}
if (!/^\s*postgres(ql)?:\/\//i.test(url)) {
  fail('SUPABASE_DB_URL must be a postgres:// connection string.');
  process.exit(1);
}

/* -------------------------------------------------------------- migrations */

const files = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith('.sql'))
  .sort();

const plan = onlyFile ? [onlyFile.split(/[\\/]/).pop()] : files;
for (const name of plan) {
  if (!files.includes(name)) {
    fail(`${name} is not in supabase/migrations`);
    process.exit(1);
  }
}

/* ------------------------------------------------------------------- apply */

// `pg` is not a dependency of this project (the app talks PostgREST, never raw SQL), so it is imported
// only when this script actually runs.
let pg;
try {
  pg = await import('pg');
} catch {
  fail('the "pg" package is not installed — this script needs it to run DDL.');
  console.log(`
  Either install it for this machine (it is not added to package.json):

    npm i --no-save pg

  ...or use the dashboard route described above, which needs nothing installed.
`);
  process.exit(1);
}

const client = new pg.default.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

try {
  await client.connect();
} catch (error) {
  fail(`cannot connect: ${error.message}`);
  info('check the password/host in SUPABASE_DB_URL, and that the project is not paused');
  process.exit(1);
}

/** The ledger: one row per migration that has run, so `db-push` is safe to repeat. */
await client.query(`
  create table if not exists public.schema_migrations (
    name        text primary key,
    applied_at  timestamptz not null default now(),
    checksum    text not null
  )`);

const applied = new Map(
  (await client.query('select name, checksum from public.schema_migrations')).rows.map((row) => [
    row.name,
    row.checksum,
  ]),
);

if (statusOnly) {
  console.log('\n  migrations\n');
  for (const name of files) {
    const state = applied.has(name) ? paint(32, 'applied') : paint(33, 'pending');
    console.log(`  ${state}  ${name}`);
  }
  console.log('');
  await client.end();
  process.exit(0);
}

const { createHash } = await import('node:crypto');
let ran = 0;
let skipped = 0;

console.log('\n  applying migrations to the configured database\n');

for (const name of plan) {
  const path = join(MIGRATIONS_DIR, name);
  const sql = readFileSync(path, 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex').slice(0, 16);

  if (applied.has(name) && applied.get(name) === checksum) {
    ok(`${name}  already applied`);
    skipped += 1;
    continue;
  }
  if (applied.has(name)) {
    // Same name, different bytes. Re-running is usually harmless (the migration is idempotent) but the
    // owner should know their file changed after it was applied.
    info(`${name}  file changed since it was applied (${applied.get(name)} -> ${checksum}), re-running`);
  }
  if (dryRun) {
    info(`${name}  would run (${(sql.length / 1024).toFixed(1)} kB)`);
    continue;
  }

  const started = Date.now();
  try {
    // One transaction per file: a migration that fails half way leaves nothing behind.
    await client.query('begin');
    await client.query(sql);
    await client.query(
      `insert into public.schema_migrations (name, checksum) values ($1, $2)
       on conflict (name) do update set checksum = excluded.checksum, applied_at = now()`,
      [name, checksum],
    );
    await client.query('commit');
    ok(`${name}  applied in ${Date.now() - started} ms`);
    ran += 1;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    fail(`${name}  failed: ${error.message}`);
    if (error.position) info(`at character ${error.position} of the file`);
    if (error.hint) info(error.hint);
    await client.end();
    process.exit(1);
  }
}

await client.end();

console.log('');
if (dryRun) {
  console.log(`  dry run: ${plan.length - skipped} migration(s) would run, ${skipped} already applied\n`);
} else {
  console.log(`  ${ran} applied · ${skipped} already applied\n`);
  if (ran > 0) console.log('  Next: npm run db:verify\n');
}
