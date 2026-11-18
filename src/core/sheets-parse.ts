import type { SheetRowIssue, SheetTopicRow } from './ports';
import type { ISODate } from './types';

/** Accepted header spellings, normalised to letters + digits only. */
const HEADER_ALIASES = {
  date: ['date', 'topicdate', 'scheduledate', 'postdate'],
  topic: ['topic', 'title', 'subject', 'ideatopic'],
  contentType: ['contenttype', 'type', 'format', 'posttype'],
  keyPoints: ['keypoints', 'points', 'keypoint', 'notes', 'sourcematerial', 'details'],
  targetAudience: ['targetaudience', 'audience', 'persona'],
  status: ['status', 'state', 'poststatus'],
  generatedPost: ['generatedpost', 'generatedcontent', 'post', 'draft', 'content'],
  hashtags: ['hashtags', 'tags', 'hashtag'],
  approval: ['approval', 'approved', 'approvalstatus'],
  publishTime: ['publishtime', 'time', 'scheduledtime', 'publishat'],
  publishedUrl: ['publishedurl', 'url', 'link', 'posturl', 'linkedinurl'],
} as const;

type ColumnKey = keyof typeof HEADER_ALIASES;

const REQUIRED_COLUMNS: ColumnKey[] = ['date', 'topic'];

/** Statuses that mean "already handled" - these rows must never be generated again. */
const HANDLED_STATUSES = new Set([
  'generated',
  'approved',
  'published',
  'rejected',
  'skipped',
  'expired',
  'processing',
  'failed',
]);

const HANDLED_APPROVALS = new Set(['approved', 'rejected']);

const ELIGIBLE_STATUSES = new Set(['', 'pending', 'ready', 'planned', 'todo', 'queued']);

export function normalizeHeader(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function normalizeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function findColumnIndex(headers: string[], aliases: readonly string[]): number {
  for (const alias of aliases) {
    const index = headers.findIndex((header) => header === alias);
    if (index >= 0) return index;
  }
  return -1;
}

/** Google Sheets serial dates (days since 1899-12-30) plus common string formats. */
export function parseSheetDate(value: unknown): ISODate | null {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value < 1 || value > 80000) return null;
    const ms = Date.UTC(1899, 11, 30) + Math.round(value) * 86_400_000;
    return new Date(ms).toISOString().slice(0, 10);
  }

  const text = String(value).trim();
  const isoMatch = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) return buildDate(isoMatch[1]!, isoMatch[2]!, isoMatch[3]!);

  const dmy = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (dmy) return buildDate(dmy[3]!, dmy[2]!, dmy[1]!);

  const monthName = text.match(/^(\d{1,2})[ -]([A-Za-z]{3,9})[ -](\d{4})$/);
  if (monthName) {
    const months = [
      'january',
      'february',
      'march',
      'april',
      'may',
      'june',
      'july',
      'august',
      'september',
      'october',
      'november',
      'december',
    ];
    const monthIndex = months.findIndex((month) => month.startsWith(monthName[2]!.toLowerCase()));
    if (monthIndex >= 0) return buildDate(monthName[3]!, String(monthIndex + 1), monthName[1]!);
  }

  const parsed = Date.parse(text);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  return null;
}

function buildDate(year: string, month: string, day: string): ISODate | null {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) return null;
  if (!Number.isInteger(m) || m < 1 || m > 12) return null;
  if (!Number.isInteger(d) || d < 1 || d > 31) return null;
  const candidate = new Date(Date.UTC(y, m - 1, d));
  if (candidate.getUTCMonth() !== m - 1 || candidate.getUTCDate() !== d) return null;
  return candidate.toISOString().slice(0, 10);
}

export function parsePublishTime(value: unknown): string | null {
  const text = normalizeCell(value);
  if (!text) return null;
  const match = text.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3]?.toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export interface ParsedSheet {
  rows: SheetTopicRow[];
  issues: SheetRowIssue[];
  headerRow: number;
  columnsFound: string[];
  columnsMissing: string[];
  skippedHandled: number;
}

/**
 * Parse a Google Sheets values snapshot into eligible topic rows.
 * Invalid rows are reported as issues instead of aborting the whole sync.
 */
export function parseSheetValues(values: unknown[][]): ParsedSheet {
  const issues: SheetRowIssue[] = [];
  const rows: SheetTopicRow[] = [];
  let skippedHandled = 0;

  if (!Array.isArray(values) || values.length === 0) {
    return {
      rows,
      issues: [
        { rowNumber: 0, reason: 'Sheet is empty. Add a header row and at least one topic.' },
      ],
      headerRow: 0,
      columnsFound: [],
      columnsMissing: [...REQUIRED_COLUMNS],
      skippedHandled: 0,
    };
  }

  const headerScanLimit = Math.min(values.length, 5);
  let headerIndex = -1;
  let headerNames: string[] = [];

  for (let index = 0; index < headerScanLimit; index += 1) {
    const candidate = (values[index] ?? []).map(normalizeHeader);
    const hasDate = findColumnIndex(candidate, HEADER_ALIASES.date) >= 0;
    const hasTopic = findColumnIndex(candidate, HEADER_ALIASES.topic) >= 0;
    if (hasDate && hasTopic) {
      headerIndex = index;
      headerNames = candidate;
      break;
    }
  }

  if (headerIndex < 0) {
    const firstRow = (values[0] ?? []).map(String).filter(Boolean).join(', ');
    return {
      rows,
      issues: [
        {
          rowNumber: 1,
          reason: `Could not find required DATE and TOPIC headers. First row contains: ${firstRow || '(empty)'}`,
        },
      ],
      headerRow: 1,
      columnsFound: [],
      columnsMissing: [...REQUIRED_COLUMNS],
      skippedHandled: 0,
    };
  }

  const columnMap = Object.fromEntries(
    (Object.keys(HEADER_ALIASES) as ColumnKey[]).map((key) => [
      key,
      findColumnIndex(headerNames, HEADER_ALIASES[key]),
    ]),
  ) as Record<ColumnKey, number>;

  const columnsMissing = REQUIRED_COLUMNS.filter((key) => columnMap[key] < 0);
  const columnsFound = Object.entries(columnMap)
    .filter(([, index]) => index >= 0)
    .map(([key]) => key);

  for (let index = headerIndex + 1; index < values.length; index += 1) {
    const raw = values[index] ?? [];
    const rowNumber = index + 1;
    const cell = (key: ColumnKey): unknown => {
      const columnIndex = columnMap[key];
      return columnIndex >= 0 ? raw[columnIndex] : undefined;
    };

    const topic = normalizeCell(cell('topic'));
    const dateValue = cell('date');
    const status = normalizeCell(cell('status')).toLowerCase();
    const approval = normalizeCell(cell('approval')).toLowerCase();
    const publishedUrl = normalizeCell(cell('publishedUrl'));

    const isBlankRow = raw.every((value) => normalizeCell(value) === '');
    if (isBlankRow) continue;

    if (!topic) {
      if (normalizeCell(dateValue)) issues.push({ rowNumber, reason: 'Missing TOPIC value' });
      continue;
    }

    const date = parseSheetDate(dateValue);
    if (!date) {
      issues.push({
        rowNumber,
        reason: `Invalid or missing DATE "${normalizeCell(dateValue)}". Use YYYY-MM-DD (recommended) or DD/MM/YYYY.`,
      });
      continue;
    }

    if (HANDLED_STATUSES.has(status) || HANDLED_APPROVALS.has(approval) || publishedUrl) {
      skippedHandled += 1;
      continue;
    }

    if (!ELIGIBLE_STATUSES.has(status)) {
      issues.push({
        rowNumber,
        reason: `Unrecognised STATUS "${status}" - row ignored (treated as not pending)`,
      });
      continue;
    }

    rows.push({
      rowNumber,
      date,
      topic,
      contentType: normalizeCell(cell('contentType')).toLowerCase() || 'insight',
      keyPoints: normalizeCell(cell('keyPoints')) || null,
      targetAudience: normalizeCell(cell('targetAudience')) || null,
      status: status || 'pending',
      approval,
      generatedPost: normalizeCell(cell('generatedPost')) || null,
      hashtags: normalizeCell(cell('hashtags')) || null,
      publishTime: parsePublishTime(cell('publishTime')),
      publishedUrl: publishedUrl || null,
    });
  }

  return {
    rows,
    issues,
    headerRow: headerIndex + 1,
    columnsFound,
    columnsMissing,
    skippedHandled,
  };
}

export const SHEET_COLUMN_ORDER = [
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
] as const;

export { REQUIRED_COLUMNS, HEADER_ALIASES };
