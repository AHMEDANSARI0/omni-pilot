/**
 * One command to prove the migrations on a machine without a Supabase account.
 *
 *   docker compose -f docker/compose.local.yml up -d
 *   npm run db:local
 *
 * Steps: create the Supabase roles (anon / authenticated / service_role) if they are missing,
 * apply every file in supabase/migrations in order (twice - each one must be idempotent), then run
 * the same contract check `npm run db:contract` runs against a real project.
 *
 * It refuses to touch SUPABASE_URL, so it can never be pointed at production by accident.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';

const HOST = process.env.LOCAL_DB_HOST ?? '127.0.0.1';
const PORT = process.env.LOCAL_DB_PORT ?? '54322';
// A non-default port must also be used for the JWTs and the gateway URL, otherwise the anon check and
// the contract check would silently talk to a different stack.
const REST_BASE = process.env.LOCAL_REST_URL ?? `http://${HOST}:${process.env.LOCAL_REST_PORT ?? '54321'}`;
const JWT_SECRET =
  process.env.LOCAL_JWT_SECRET ?? 'super-secret-jwt-token-with-at-least-32-characters-long';
const DATABASE = 'postpilot';

function psql(args, label) {
  try {
    return execFileSync(
      'psql',
      [
        '-h',
        HOST,
        '-p',
        PORT,
        '-U',
        'postgres',
        '-d',
        DATABASE,
        '-v',
        'ON_ERROR_STOP=1',
        ...args,
      ],
      { encoding: 'utf8', env: { ...process.env, PGPASSWORD: 'postgres' }, stdio: 'pipe' },
    );
  } catch (error) {
    const detail = error.stderr?.trim() || error.message;
    console.error(`\n✖ ${label} failed\n${detail}\n`);
    console.error(
      'Is the local stack running? `docker compose -f docker/compose.local.yml up -d`\n' +
        'Is psql installed? It ships with PostgreSQL (or use the psql inside the db container).',
    );
    process.exit(1);
  }
}

function serviceRoleJwt() {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({ role: 'service_role', exp: Math.floor(Date.now() / 1000) + 86_400 * 365 });
  const signature = createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

// 1. Roles that Supabase always has. Local Postgres does not, and the migrations grant to them.
psql(
  [
    '-q',
    '-c',
    `do $$
     begin
       if not exists (select 1 from pg_roles where rolname = 'anon') then
         create role anon nologin noinherit;
       end if;
       if not exists (select 1 from pg_roles where rolname = 'authenticated') then
         create role authenticated nologin noinherit;
       end if;
       if not exists (select 1 from pg_roles where rolname = 'service_role') then
         create role service_role nologin noinherit bypassrls;
       end if;
     end $$;`,
  ],
  'create roles',
);
console.log('ok   Supabase roles present (anon, authenticated, service_role)');

// 2. Migrations, in filename order, twice: the second pass proves idempotency.
const dir = join(process.cwd(), 'supabase', 'migrations');
const files = readdirSync(dir)
  .filter((name) => name.endsWith('.sql'))
  .sort();

if (files.length === 0) {
  console.error('No migrations found in supabase/migrations.');
  process.exit(1);
}

for (const pass of [1, 2]) {
  for (const file of files) {
    psql(['-q', '-f', join(dir, file)], `${file} (pass ${pass})`);
    console.log(`ok   ${file}${pass === 2 ? ' — re-applied cleanly' : ''}`);
  }
}

// 3. Security: RLS on every table, and the anon key must be able to read nothing.
const rls = psql(
  [
    '-At',
    '-c',
    `select
       (select count(*) from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity),
       (select count(*) from pg_policies where schemaname = 'public'),
       (select count(*) from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r'
           and has_table_privilege('anon'::name, c.oid, 'select'))`,
  ],
  'rls check',
).trim();
const [withoutRls, policyCount, anonReadable] = rls.split('|').map((value) => Number(value));
if (withoutRls !== 0) {
  console.error(`✖ ${withoutRls} table(s) in public have RLS disabled.`);
  process.exit(1);
}
if (anonReadable !== 0) {
  console.error(`✖ anon can read ${anonReadable} table(s); the browser must never reach the database.`);
  process.exit(1);
}
console.log(`ok   RLS on every table (${policyCount} policies, anon read access: none)`);

async function anonProbe() {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({ role: 'anon', exp: Math.floor(Date.now() / 1000) + 600 });
  const signature = createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  const token = `${header}.${payload}.${signature}`;
  const response = await fetch(`${REST_BASE}/rest/v1/app_settings?select=*`, {
    headers: { apikey: token, Authorization: `Bearer ${token}` },
  });
  const body = await response.text();
  if (response.ok && body.trim() !== '[]') {
    console.error(`✖ anon key can read app_settings through PostgREST (status ${response.status}).`);
    process.exit(1);
  }
  console.log(`ok   anon key through PostgREST: status ${response.status} (no rows)`);
}
await anonProbe();

// 4. The contract check, against the local PostgREST.
console.log('\nRunning the database contract check against the local PostgREST…\n');
try {
  execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/verify-db-contract.ts'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      SUPABASE_URL: REST_BASE,
      SUPABASE_SERVICE_ROLE_KEY: serviceRoleJwt(),
    },
  });
} catch {
  process.exit(1);
}
