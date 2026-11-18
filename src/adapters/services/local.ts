import type {
  EmailGateway,
  EmailMessage,
  LinkedInGateway,
  LinkedInStatus,
  SheetRowUpdate,
  SheetSnapshot,
  SheetsGateway,
} from '@/src/core/ports';
import { addDays, isoDate } from '@/src/core/time';
import { AppError } from '@/src/core/errors';

/**
 * Local-development stand-ins for external services.
 *
 * Enabled only when SERVICES_MODE=local (the default for APP_ENV=development). Records are
 * visibly tagged `local-dev` in the dashboard so a developer never mistakes them for real
 * deliveries, and the LinkedIn stub always refuses to publish instead of pretending.
 */

const outbox: Array<EmailMessage & { id: string; sentAt: string }> = [];

export class LocalEmailGateway implements EmailGateway {
  describe(): Promise<{ connected: boolean; fromEmail: string }> {
    return Promise.resolve({ connected: true, fromEmail: 'local-dev@outbox.test' });
  }

  send(message: EmailMessage): Promise<{ messageId: string }> {
    const id = `local-${Date.now()}-${outbox.length + 1}`;
    outbox.unshift({ ...message, id, sentAt: new Date().toISOString() });
    if (outbox.length > 50) outbox.length = 50;
    console.log(`[local-email] to=${message.to} subject=${message.subject}`);
    return Promise.resolve({ messageId: id });
  }
}

export function readLocalOutbox(): typeof outbox {
  return outbox;
}

export class LocalLinkedInGateway implements LinkedInGateway {
  status(): Promise<LinkedInStatus> {
    return Promise.resolve({
      connected: false,
      label: null,
      expiresAt: null,
      needsReauth: true,
    });
  }

  publish(): Promise<{ externalId: string; url: string }> {
    return Promise.reject(
      new AppError(
        'LINKEDIN_ERROR',
        'Local development mode: LinkedIn publishing is disabled. Connect a real LinkedIn app to publish.',
        { details: { code: 'needs_reauth' } },
      ),
    );
  }
}

interface LocalSheetState {
  rows: unknown[][];
}

const sheetStates = new Map<string, LocalSheetState>();

function defaultSheetRows(): unknown[][] {
  const today = isoDate(new Date());
  return [
    [
      'DATE',
      'TOPIC',
      'CONTENT TYPE',
      'KEY POINTS',
      'TARGET AUDIENCE',
      'STATUS',
      'GENERATED POST',
      'HASHTAGS',
      'APPROVAL',
      'PUBLISH TIME',
      'PUBLISHED URL',
    ],
    [
      today,
      'Idempotency keys for AI agent tool calls',
      'insight',
      'Agents retried the same tool call after a timeout and created duplicate records. Added idempotency keys keyed on tool+args hash.',
      'Engineers building agentic systems',
      'Pending',
      '',
      '',
      '',
      '09:30',
      '',
    ],
    [
      addDays(today, 1),
      'Designing retries that do not duplicate side effects',
      'how-to',
      'Separate transport retries from business retries; persist attempts; only retry idempotent steps automatically.',
      'Backend and automation engineers',
      'Pending',
      '',
      '',
      '',
      '09:30',
      '',
    ],
    [
      addDays(today, 2),
      'What actually broke in our Python workflow automation',
      'story',
      'Scheduler overlap, missing locks and silent failures. Fix was a claim table and explicit status transitions.',
      'Python developers',
      'Pending',
      '',
      '',
      '',
      '09:30',
      '',
    ],
  ];
}

/** Minimal in-memory spreadsheet that behaves like the Google Sheets gateway. */
export class LocalSheetsGateway implements SheetsGateway {
  constructor(private readonly sheetKey = 'local-dev-sheet') {
    if (!sheetStates.has(this.sheetKey)) {
      sheetStates.set(this.sheetKey, { rows: defaultSheetRows() });
    }
  }

  private state(): LocalSheetState {
    return sheetStates.get(this.sheetKey)!;
  }

  describe(): Promise<{ connected: boolean; sheetLabel: string; sheetId: string | null }> {
    return Promise.resolve({
      connected: true,
      sheetLabel: 'local-dev spreadsheet',
      sheetId: 'local-dev',
    });
  }

  async readRows(): Promise<SheetSnapshot> {
    const { parseSheetValues } = await import('@/src/core/sheets-parse');
    const parsed = parseSheetValues(this.state().rows);
    return { rows: parsed.rows, issues: parsed.issues, sheetLabel: 'local-dev spreadsheet' };
  }

  async updateRows(updates: SheetRowUpdate[]): Promise<void> {
    const rows = this.state().rows;
    const headers = (rows[0] ?? []).map((value) =>
      String(value ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, ''),
    );
    const indexOf = (aliases: string[]): number =>
      headers.findIndex((header) => aliases.includes(header));
    const columns: Record<string, number> = {
      status: indexOf(['status', 'state']),
      generatedPost: indexOf(['generatedpost', 'generatedcontent', 'post']),
      hashtags: indexOf(['hashtags', 'tags']),
      approval: indexOf(['approval', 'approved']),
      publishTime: indexOf(['publishtime', 'time']),
      publishedUrl: indexOf(['publishedurl', 'url', 'link']),
    };
    for (const update of updates) {
      const row = rows[update.rowNumber - 1];
      if (!row) continue;
      for (const [field, value] of Object.entries(update)) {
        if (field === 'rowNumber' || value === undefined) continue;
        const index = columns[field];
        if (index === undefined || index < 0) continue;
        row[index] = value;
      }
    }
  }

  reset(): void {
    sheetStates.set(this.sheetKey, { rows: defaultSheetRows() });
  }
}
