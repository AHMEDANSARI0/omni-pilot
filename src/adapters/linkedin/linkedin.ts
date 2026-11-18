import { AppError, safeErrorMessage } from '@/src/core/errors';
import { isoInstant } from '@/src/core/time';
import type {
  Cipher,
  Database,
  LinkedInGateway,
  LinkedInPublishInput,
  LinkedInStatus,
} from '@/src/core/ports';
import type { AppConfig } from '@/src/config/env';

const API_BASE = 'https://api.linkedin.com';
const MAX_COMMENTARY_CHARS = 3000;

export interface LinkedInOptions {
  db: Database;
  cipher: Cipher;
  config: AppConfig;
  fetchImpl?: typeof fetch;
}

interface StoredCredentials {
  accessToken: string;
  authorUrn: string | null;
  expiresAt: string | null;
  personName: string | null;
}

/**
 * Official LinkedIn Posts API adapter (self-serve "Share on LinkedIn" product,
 * scope w_member_social). No browser automation, cookies or password flows.
 */
export class LinkedInGatewayImpl implements LinkedInGateway {
  private readonly db: Database;
  private readonly cipher: Cipher;
  private readonly config: AppConfig;
  private readonly http: typeof fetch;

  constructor(options: LinkedInOptions) {
    this.db = options.db;
    this.cipher = options.cipher;
    this.config = options.config;
    this.http = options.fetchImpl ?? fetch;
  }

  private async credentials(): Promise<StoredCredentials> {
    const integration = await this.db.getIntegration('linkedin');
    if (!integration?.accessTokenEnc) {
      throw new AppError(
        'LINKEDIN_ERROR',
        'LinkedIn is not connected. Open Settings and connect your LinkedIn account.',
        { details: { needsReauth: true } },
      );
    }
    const accessToken = await this.cipher.decrypt(integration.accessTokenEnc);
    return {
      accessToken,
      authorUrn:
        typeof integration.metadata?.authorUrn === 'string' ? integration.metadata.authorUrn : null,
      expiresAt: integration.tokenExpiresAt,
      personName:
        typeof integration.metadata?.personName === 'string'
          ? integration.metadata.personName
          : null,
    };
  }

  async status(): Promise<LinkedInStatus> {
    const integration = await this.db.getIntegration('linkedin');
    if (!integration?.accessTokenEnc) {
      return { connected: false, label: null, expiresAt: null, needsReauth: false };
    }
    const expiresAt = integration.tokenExpiresAt;
    const expired = expiresAt ? new Date(expiresAt).getTime() <= Date.now() : false;
    const needsReauth = expired || integration.status === 'needs_reauth';
    return {
      connected: !needsReauth,
      label:
        (typeof integration.metadata?.personName === 'string' && integration.metadata.personName) ||
        integration.accountLabel ||
        null,
      expiresAt,
      needsReauth,
    };
  }

  async publish(input: LinkedInPublishInput): Promise<{ externalId: string; url: string }> {
    const commentary = input.commentary.trim();
    if (!commentary) {
      throw new AppError('LINKEDIN_ERROR', 'Refusing to publish an empty post.');
    }
    if (Array.from(commentary).length > MAX_COMMENTARY_CHARS) {
      throw new AppError(
        'LINKEDIN_ERROR',
        `Post is ${Array.from(commentary).length} characters; LinkedIn accepts ${MAX_COMMENTARY_CHARS} max.`,
      );
    }

    const credentials = await this.credentials();
    if (credentials.expiresAt && new Date(credentials.expiresAt).getTime() <= Date.now()) {
      await this.db.upsertIntegration('linkedin', {
        status: 'needs_reauth',
        lastError: 'LinkedIn access token expired. Reconnect LinkedIn to resume publishing.',
        lastCheckedAt: isoInstant(new Date()),
      });
      throw new AppError(
        'LINKEDIN_ERROR',
        'LinkedIn access token expired. Reconnect LinkedIn in Settings (self-serve apps get 60-day tokens and no refresh token).',
        { details: { needsReauth: true }, retryable: false },
      );
    }

    const authorUrn = credentials.authorUrn ?? (await this.fetchAuthorUrn(credentials.accessToken));

    const response = await this.http(`${API_BASE}/rest/posts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        'Content-Type': 'application/json',
        'LinkedIn-Version': this.config.linkedin.apiVersion,
        'X-Restli-Protocol-Version': '2.0.0',
      },
      body: JSON.stringify({
        author: authorUrn,
        commentary,
        visibility: 'PUBLIC',
        distribution: {
          feedDistribution: 'MAIN_FEED',
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (response.status === 201 || response.status === 200) {
      const externalId = response.headers.get('x-restli-id') ?? response.headers.get('X-Restli-Id');
      if (!externalId) {
        throw new AppError(
          'LINKEDIN_ERROR',
          'LinkedIn accepted the request but returned no post id, so the published URL cannot be recorded.',
          { details: { needsManualCheck: true } },
        );
      }
      return {
        externalId,
        url: `https://www.linkedin.com/feed/update/${encodeURIComponent(externalId)}/`,
      };
    }

    const body = await response.text();
    const snippet = safeErrorMessage(body).slice(0, 400);

    if (response.status === 401) {
      await this.db.upsertIntegration('linkedin', {
        status: 'needs_reauth',
        lastError: 'LinkedIn rejected the access token (401). Reconnect LinkedIn.',
        lastCheckedAt: isoInstant(new Date()),
      });
      throw new AppError(
        'LINKEDIN_ERROR',
        'LinkedIn access token was rejected (401). Reconnect LinkedIn.',
        {
          details: { needsReauth: true },
          retryable: false,
        },
      );
    }
    if (response.status === 403) {
      throw new AppError(
        'LINKEDIN_ERROR',
        `LinkedIn returned 403. The app needs the w_member_social scope (Share on LinkedIn product) and permission to post as this member. ${snippet}`,
        { retryable: false },
      );
    }
    if (response.status === 422) {
      throw new AppError('LINKEDIN_ERROR', `LinkedIn rejected the post content (422): ${snippet}`, {
        retryable: false,
      });
    }
    if (response.status === 429) {
      throw new AppError('LINKEDIN_ERROR', 'LinkedIn rate limit reached (429). Retrying later.', {
        retryable: true,
      });
    }
    throw new AppError(
      'LINKEDIN_ERROR',
      `LinkedIn publish failed (HTTP ${response.status}): ${snippet}`,
      {
        retryable: response.status >= 500,
      },
    );
  }

  private async fetchAuthorUrn(accessToken: string): Promise<string> {
    const response = await this.http(`${API_BASE}/v2/userinfo`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new AppError(
        'LINKEDIN_ERROR',
        `Could not read the LinkedIn profile (HTTP ${response.status}). Ensure the "Sign In with LinkedIn using OpenID Connect" product is added to the app.`,
        { details: { needsReauth: response.status === 401 }, retryable: response.status >= 500 },
      );
    }
    const payload = (await response.json()) as { sub?: string; name?: string };
    if (!payload.sub) {
      throw new AppError('LINKEDIN_ERROR', 'LinkedIn userinfo response had no member id.');
    }
    const authorUrn = `urn:li:person:${payload.sub}`;
    const integration = await this.db.getIntegration('linkedin');
    await this.db.upsertIntegration('linkedin', {
      metadata: { ...(integration?.metadata ?? {}), authorUrn, personName: payload.name ?? null },
      accountLabel: payload.name ?? integration?.accountLabel ?? null,
    });
    return authorUrn;
  }
}

export interface LinkedInTokenResponse {
  accessToken: string;
  expiresInSeconds: number;
}

/** Exchange a 3-legged OAuth authorization code for a member access token. */
export async function exchangeLinkedInCode(
  config: AppConfig,
  code: string,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LinkedInTokenResponse> {
  if (!config.linkedin.clientId || !config.linkedin.clientSecret) {
    throw new AppError(
      'CONFIG_ERROR',
      'LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET are not configured.',
    );
  }
  const response = await fetchImpl('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: config.linkedin.clientId,
      client_secret: config.linkedin.clientSecret,
    }).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new AppError(
      'LINKEDIN_ERROR',
      `LinkedIn token exchange failed (HTTP ${response.status}): ${safeErrorMessage(text).slice(0, 300)}`,
    );
  }
  const payload = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!payload.access_token) {
    throw new AppError('LINKEDIN_ERROR', 'LinkedIn token exchange returned no access token.');
  }
  return { accessToken: payload.access_token, expiresInSeconds: payload.expires_in ?? 5_184_000 };
}

export async function fetchLinkedInProfile(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ sub: string; name: string | null }> {
  const response = await fetchImpl(`${API_BASE}/v2/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new AppError(
      'LINKEDIN_ERROR',
      `Could not read the LinkedIn profile (HTTP ${response.status}). Ensure "Sign In with LinkedIn using OpenID Connect" is added to your app.`,
    );
  }
  const payload = (await response.json()) as { sub?: string; name?: string };
  if (!payload.sub)
    throw new AppError('LINKEDIN_ERROR', 'LinkedIn userinfo response had no member id.');
  return { sub: payload.sub, name: payload.name ?? null };
}

export function linkedInAuthorizeUrl(
  config: AppConfig,
  state: string,
  redirectUri: string,
): string {
  if (!config.linkedin.clientId) {
    throw new AppError('CONFIG_ERROR', 'LINKEDIN_CLIENT_ID is not configured.');
  }
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.linkedin.clientId,
    redirect_uri: redirectUri,
    state,
    scope: 'openid profile w_member_social',
  });
  return `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`;
}
