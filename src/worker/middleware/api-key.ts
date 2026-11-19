import type { MiddlewareHandler } from 'hono';
import { AppError } from '@/src/core/errors';
import { API_KEY_PREFIX, apiKeyMatches, hashApiKey, type ApiScope } from '@/src/core/omni';
import type { AppEnv } from '../types';

/**
 * Machine authentication for the OmniFlow API.
 *
 * The key is presented as `Authorization: Bearer opk_...` or `X-Api-Key: opk_...`, hashed, and looked up
 * by hash - the plaintext never leaves the request. Two things are deliberately different from the
 * dashboard's session auth:
 *
 *   1. A revoked key is rejected even when its hash row still exists, so revocation takes effect on the
 *      very next request rather than when a cached session expires.
 *   2. Scopes are enforced per route, not per user: `read` can look, `write` can create topics and
 *      approve, `publish` can push a post live. A leaked read key cannot publish anything.
 */
export interface ApiKeyContext {
  apiKeyId: string;
  scopes: ApiScope[];
  actor: string;
}

declare module 'hono' {
  interface ContextVariableMap {
    apiKey?: ApiKeyContext;
  }
}

function presentedKey(c: Parameters<MiddlewareHandler<AppEnv>>[0]): string | null {
  const header = c.req.header('authorization') ?? c.req.header('Authorization');
  if (header?.toLowerCase().startsWith('bearer ')) {
    const token = header.slice(7).trim();
    // A dashboard session token is not an API key; only `opk_` keys are machine credentials.
    if (token.startsWith(API_KEY_PREFIX)) return token;
  }
  const direct = c.req.header('x-api-key');
  if (direct?.startsWith(API_KEY_PREFIX)) return direct.trim();
  return null;
}

/** Authenticates any `opk_` key and loads its scopes. Rejects everything else. */
export const requireApiKey: MiddlewareHandler<AppEnv> = async (c, next) => {
  const services = c.get('services');
  const key = presentedKey(c);
  if (!key) {
    throw new AppError('UNAUTHORIZED', 'This endpoint needs an API key.', {
      details: {
        hint: 'Send Authorization: Bearer opk_... or X-Api-Key: opk_... (create one in Settings → API).',
      },
    });
  }

  const record = await services.db.findApiKeyByHash(hashApiKey(key));
  // Compare in constant time even though the lookup already matched: this keeps the failure path free of
  // an obvious timing difference between "no such key" and "wrong key".
  if (!record || !apiKeyMatches(key, record.keyHash)) {
    throw new AppError('UNAUTHORIZED', 'That API key is not recognised.');
  }
  if (record.revokedAt) {
    throw new AppError('UNAUTHORIZED', 'That API key was revoked.', {
      details: { revokedAt: record.revokedAt },
    });
  }

  c.set('apiKey', {
    apiKeyId: record.id,
    scopes: record.scopes,
    actor: `api:${record.name || record.keyPrefix}`,
  });
  c.set('actor', `api:${record.name || record.keyPrefix}`);

  // Usage tracking must never fail a request the key was allowed to make.
  await services.db.touchApiKey(record.id, services.clock.now().toISOString()).catch(() => undefined);
  await next();
};

/** Requires one scope on top of a valid key. */
export function requireScope(scope: ApiScope): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const key = c.get('apiKey');
    if (!key) throw new AppError('UNAUTHORIZED', 'This endpoint needs an API key.');
    if (!key.scopes.includes(scope)) {
      throw new AppError('FORBIDDEN', `This key does not have the "${scope}" scope.`, {
        details: { scopes: key.scopes, required: scope },
      });
    }
    await next();
  };
}
