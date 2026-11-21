/**
 * The two Supabase settings every script in `scripts/` needs, resolved the same way everywhere.
 *
 * Written after `npm run db:contract` printed "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required"
 * while those keys sat in `.env.local` - because `db:verify` loaded that file itself and
 * `db:contract` never did. Two scripts, two behaviours, one confusing afternoon.
 *
 * `npm run db:verify` is a bare `tsx scripts/verify-db.ts`, so no `--env-file` flag reaches the process;
 * the file has to be read in code. Node 20.6+ can do it without a dependency.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** The files a developer actually keeps keys in, in the order they should win. */
const ENV_FILES = ['.env.local', '.env'];

/**
 * Reads `.env.local` (or `.env`) when the variables are not already in the environment.
 *
 * Values already present in `process.env` win - an explicit `set SUPABASE_URL=...` for one run, or a CI
 * secret, must never be overridden by a file on disk.
 */
export function loadLocalEnv(cwd = process.cwd()): void {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) return;
  for (const file of ENV_FILES) {
    const path = join(cwd, file);
    if (!existsSync(path)) continue;
    try {
      process.loadEnvFile(path);
    } catch {
      // An older Node without `loadEnvFile`: the message below is the fallback.
      return;
    }
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) return;
  }
}

export interface KeyIdentity {
  role: string;
  problem?: string;
}

/**
 * Says which role a key actually is.
 *
 * A wrong key is worth one sentence, not thirty-one: the first run of `db:verify` against a real project
 * printed eighteen `permission denied for table` lines and eight for functions, all with a single cause -
 * the key was the publishable/anon one, so PostgREST connected as `anon`, which this schema grants nothing.
 *
 * A JWT (the legacy `eyJ...` keys) carries its role in the payload. The newer `sb_secret_` /
 * `sb_publishable_` keys are not JWTs, so the prefix is the only signal - and it is exact.
 */
export function describeKey(key: string): KeyIdentity {
  if (key.startsWith('sb_secret_')) return { role: 'service_role' };
  if (key.startsWith('sb_publishable_')) {
    return {
      role: 'anon',
      problem: 'this is the publishable (anon) key. RLS and the revokes in 0001 mean it can read nothing.',
    };
  }
  if (key.startsWith('sb_')) return { role: 'unknown', problem: 'unrecognised sb_ key prefix.' };
  const parts = key.split('.');
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as {
        role?: string;
      };
      const role = payload.role ?? 'unknown';
      if (role !== 'service_role') {
        return { role, problem: `the JWT says role "${role}", not "service_role".` };
      }
      return { role };
    } catch {
      return { role: 'unknown', problem: 'the JWT payload did not decode.' };
    }
  }
  return { role: 'unknown', problem: 'not a JWT and not an sb_ key.' };
}

/** The message to print instead of measuring the database with a key that cannot see it. */
export function wrongKeyMessage(identity: KeyIdentity, key: string): string {
  const anon = process.env.SUPABASE_ANON_KEY?.trim();
  const sameKey = anon !== undefined && anon === key;
  return (
    `This is not the service_role key, so nothing in the database can be checked.\n\n` +
    `  ${identity.problem}\n\n` +
    (sameKey
      ? '  SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY hold the SAME key. That is the mistake:\n' +
        '  the anon key cannot read this schema by design, and it never will.\n\n'
      : '') +
    '  Where to get it: Supabase dashboard -> Project Settings -> API Keys\n' +
    '    * Legacy tab                      -> the long `eyJ...` key whose role is service_role\n' +
    '    * Publishable and secret API keys -> `sb_secret_...` (it behaves as service_role)\n' +
    '  Never `sb_publishable_...` - that one is anon.\n\n' +
    '  Put it in .env.local as:\n' +
    '    SUPABASE_SERVICE_ROLE_KEY=<the service_role key>\n\n' +
    '  Then run this again. Nothing has been changed in your database.\n'
  );
}

export interface SupabaseTarget {
  url: string;
  key: string;
}

/**
 * Resolves the project URL and key, or exits with a message that names the actual problem:
 * no keys at all, a key for the wrong role, or an URL that does not look like a Supabase project.
 */
export function requireSupabase(fallbackEnvFileHint = '.env.local'): SupabaseTarget {
  loadLocalEnv();
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url || !key) {
    console.error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.\n\n' +
        `  Put them in ${fallbackEnvFileHint} at the project root (the same file \`npm run dev:api\` uses):\n\n` +
        '    SUPABASE_URL=https://<ref>.supabase.co\n' +
        '    SUPABASE_SERVICE_ROLE_KEY=<service-role-key>\n\n' +
        '  Or pass them for one run:\n\n' +
        '    set SUPABASE_URL=https://<ref>.supabase.co\n' +
        '    set SUPABASE_SERVICE_ROLE_KEY=<key>\n' +
        '    npm run db:verify\n',
    );
    process.exit(1);
  }

  const identity = describeKey(key);
  if (identity.problem) {
    console.error(wrongKeyMessage(identity, key));
    process.exit(1);
  }

  return { url, key };
}
