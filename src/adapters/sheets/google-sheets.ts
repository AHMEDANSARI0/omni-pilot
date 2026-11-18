import { AppError, safeErrorMessage } from '@/src/core/errors';
import { parseSheetValues } from '@/src/core/sheets-parse';
import type {
  Cipher,
  Database,
  SheetRowUpdate,
  SheetSnapshot,
  SheetsGateway,
} from '@/src/core/ports';
import type { AppConfig } from '@/src/config/env';
import { isoInstant } from '@/src/core/time';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

type WritableField = keyof Omit<SheetRowUpdate, 'rowNumber'>;

const WRITABLE_FIELDS: WritableField[] = [
  'status',
  'generatedPost',
  'hashtags',
  'approval',
  'publishTime',
  'publishedUrl',
];

export interface GoogleSheetsOptions {
  db: Database;
  cipher: Cipher;
  config: AppConfig;
  fetchImpl?: typeof fetch;
}

/**
 * Google Sheets gateway. OAuth tokens live encrypted in the `integrations` table;
 * GOOGLE_REFRESH_TOKEN can bootstrap credentials when the OAuth flow is not used yet.
 */
export class GoogleSheetsGateway implements SheetsGateway {
  private readonly db: Database;
  private readonly cipher: Cipher;
  private readonly config: AppConfig;
  private readonly http: typeof fetch;
  private cachedToken: { value: string; expiresAt: number } | null = null;

  constructor(options: GoogleSheetsOptions) {
    this.db = options.db;
    this.cipher = options.cipher;
    this.config = options.config;
    this.http = options.fetchImpl ?? fetch;
  }

  private async resolveSheet(): Promise<{ sheetId: string; tab: string }> {
    const integration = await this.db.getIntegration('google_sheets');
    const sheetId =
      (typeof integration?.metadata?.sheetId === 'string' && integration.metadata.sheetId) ||
      this.config.google.sheetId;
    const tab =
      (typeof integration?.metadata?.sheetTab === 'string' && integration.metadata.sheetTab) ||
      this.config.google.sheetTab;
    if (!sheetId) {
      throw new AppError(
        'INTEGRATION_ERROR',
        'No Google Sheet configured. Set GOOGLE_SHEET_ID or provide the sheet URL in Settings.',
      );
    }
    return { sheetId, tab };
  }

  private async loadRefreshToken(): Promise<{ refreshToken: string; fromEnv: boolean }> {
    const integration = await this.db.getIntegration('google_sheets');
    if (integration?.refreshTokenEnc) {
      return {
        refreshToken: await this.cipher.decrypt(integration.refreshTokenEnc),
        fromEnv: false,
      };
    }
    if (this.config.google.bootstrapRefreshToken) {
      return { refreshToken: this.config.google.bootstrapRefreshToken, fromEnv: true };
    }
    throw new AppError(
      'INTEGRATION_ERROR',
      'Google Sheets is not connected. Use "Connect Google Sheets" in Settings (or set GOOGLE_REFRESH_TOKEN).',
    );
  }

  private async exchangeRefreshToken(force = false): Promise<string> {
    if (!force && this.cachedToken && this.cachedToken.expiresAt > Date.now() + 60_000) {
      return this.cachedToken.value;
    }
    const integration = await this.db.getIntegration('google_sheets');
    if (
      !force &&
      integration?.accessTokenEnc &&
      integration.tokenExpiresAt &&
      new Date(integration.tokenExpiresAt).getTime() > Date.now() + 60_000
    ) {
      const decrypted = await this.cipher.decrypt(integration.accessTokenEnc);
      this.cachedToken = {
        value: decrypted,
        expiresAt: new Date(integration.tokenExpiresAt).getTime(),
      };
      return decrypted;
    }

    if (!this.config.google.clientId || !this.config.google.clientSecret) {
      throw new AppError(
        'INTEGRATION_ERROR',
        'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required to refresh Google access.',
      );
    }
    const { refreshToken, fromEnv } = await this.loadRefreshToken();

    const response = await this.http(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.google.clientId,
        client_secret: this.config.google.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      const text = await response.text();
      const invalidGrant = text.includes('invalid_grant');
      await this.db.upsertIntegration('google_sheets', {
        status: 'needs_reauth',
        lastError: invalidGrant
          ? 'Google refresh token is no longer valid (revoked or expired). Reconnect Google Sheets.'
          : `Google token refresh failed (HTTP ${response.status}).`,
        lastCheckedAt: isoInstant(new Date()),
      });
      throw new AppError(
        'SHEETS_ERROR',
        invalidGrant
          ? 'Google authorization expired. Reconnect Google Sheets in Settings.'
          : `Google token refresh failed with status ${response.status}.`,
        { retryable: !invalidGrant },
      );
    }

    const payload = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!payload.access_token) {
      throw new AppError('SHEETS_ERROR', 'Google token endpoint returned no access token');
    }
    const expiresIn = payload.expires_in ?? 3500;
    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    this.cachedToken = { value: payload.access_token, expiresAt: expiresAt.getTime() };

    await this.db.upsertIntegration('google_sheets', {
      status: 'connected',
      accessTokenEnc: await this.cipher.encrypt(payload.access_token),
      tokenExpiresAt: isoInstant(expiresAt),
      lastCheckedAt: isoInstant(new Date()),
      lastError: null,
      ...(fromEnv
        ? { metadata: { ...(integration?.metadata ?? {}), credentialSource: 'env' } }
        : {}),
    });

    return payload.access_token;
  }

  private async authorizedFetch(url: string, init: RequestInit = {}): Promise<Response> {
    let token = await this.exchangeRefreshToken();
    let response = await this.http(url, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(25_000),
    });
    if (response.status === 401) {
      token = await this.exchangeRefreshToken(true);
      response = await this.http(url, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(25_000),
      });
    }
    return response;
  }

  async describe(): Promise<{ connected: boolean; sheetLabel: string; sheetId: string | null }> {
    const integration = await this.db.getIntegration('google_sheets');
    const sheetId =
      (typeof integration?.metadata?.sheetId === 'string' && integration.metadata.sheetId) ||
      this.config.google.sheetId;
    const tab =
      (typeof integration?.metadata?.sheetTab === 'string' && integration.metadata.sheetTab) ||
      this.config.google.sheetTab;
    const hasCredentials = Boolean(
      integration?.refreshTokenEnc || this.config.google.bootstrapRefreshToken,
    );
    return {
      connected: Boolean(sheetId && hasCredentials && integration?.status !== 'needs_reauth'),
      sheetLabel: sheetId ? `${tab} · ${sheetId.slice(0, 8)}…` : 'not configured',
      sheetId: sheetId ?? null,
    };
  }

  async readRows(): Promise<SheetSnapshot> {
    const { sheetId, tab } = await this.resolveSheet();
    const range = `${quoteTab(tab)}!A1:Z2000`;
    const response = await this.authorizedFetch(
      `${SHEETS_API}/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`,
    );

    if (!response.ok) {
      const text = await response.text();
      throw new AppError('SHEETS_ERROR', describeSheetsError(response.status, text), {
        retryable: response.status === 429 || response.status >= 500,
        details: { status: response.status },
      });
    }

    const payload = (await response.json()) as { values?: unknown[][] };
    const parsed = parseSheetValues(payload.values ?? []);
    return {
      rows: parsed.rows,
      issues: parsed.issues,
      sheetLabel: tab,
    };
  }

  async updateRows(updates: SheetRowUpdate[]): Promise<void> {
    if (updates.length === 0) return;
    const { sheetId, tab } = await this.resolveSheet();
    const columnMap = await this.readHeaderColumns(sheetId, tab);

    const data: Array<{ range: string; values: string[][] }> = [];
    for (const update of updates) {
      for (const field of WRITABLE_FIELDS) {
        const value = update[field];
        if (value === undefined) continue;
        const columnIndex = columnMap[field];
        if (columnIndex === undefined || columnIndex < 0) continue;
        data.push({
          range: `${quoteTab(tab)}!${columnLetter(columnIndex)}${update.rowNumber}`,
          values: [[value]],
        });
      }
    }
    if (data.length === 0) return;

    const response = await this.authorizedFetch(
      `${SHEETS_API}/${encodeURIComponent(sheetId)}/values:batchUpdate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
      },
    );
    if (!response.ok) {
      const text = await response.text();
      throw new AppError('SHEETS_ERROR', describeSheetsError(response.status, text), {
        retryable: response.status === 429 || response.status >= 500,
        details: { status: response.status },
      });
    }
  }

  private async readHeaderColumns(sheetId: string, tab: string): Promise<Record<string, number>> {
    const range = `${quoteTab(tab)}!A1:Z5`;
    const response = await this.authorizedFetch(
      `${SHEETS_API}/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`,
    );
    if (!response.ok) {
      throw new AppError(
        'SHEETS_ERROR',
        describeSheetsError(response.status, await response.text()),
      );
    }
    const payload = (await response.json()) as { values?: unknown[][] };
    const rows = payload.values ?? [];
    const aliases: Record<string, string[]> = {
      status: ['status', 'state', 'poststatus'],
      generatedPost: ['generatedpost', 'generatedcontent', 'post', 'draft', 'content'],
      hashtags: ['hashtags', 'tags', 'hashtag'],
      approval: ['approval', 'approved', 'approvalstatus'],
      publishTime: ['publishtime', 'time', 'scheduledtime', 'publishat'],
      publishedUrl: ['publishedurl', 'url', 'link', 'posturl', 'linkedinurl'],
    };
    const normalize = (value: unknown) =>
      String(value ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');

    for (const row of rows) {
      const headers = row.map(normalize);
      if (headers.includes('date') && headers.includes('topic')) {
        const map: Record<string, number> = {};
        for (const [field, fieldAliases] of Object.entries(aliases)) {
          const index = headers.findIndex((header) => fieldAliases.includes(header));
          if (index >= 0) map[field] = index;
        }
        return map;
      }
    }
    return {};
  }
}

function quoteTab(tab: string): string {
  return `'${tab.replace(/'/g, "''")}'`;
}

function columnLetter(index: number): string {
  let result = '';
  let current = index;
  while (current >= 0) {
    result = String.fromCharCode((current % 26) + 65) + result;
    current = Math.floor(current / 26) - 1;
  }
  return result;
}

function describeSheetsError(status: number, body: string): string {
  if (status === 401 || status === 403) {
    return 'Google rejected the request (permission denied). Reconnect Google Sheets and confirm the account can edit this spreadsheet.';
  }
  if (status === 404) {
    return 'Google Sheet not found. Check GOOGLE_SHEET_ID and that the sheet is shared with the connected Google account.';
  }
  if (status === 429) return 'Google Sheets rate limit hit. The run will retry on the next tick.';
  const snippet = safeErrorMessage(body).slice(0, 300);
  return `Google Sheets request failed (HTTP ${status}): ${snippet}`;
}

export { columnLetter, quoteTab };
