import type { Logger } from './logger';
import type { SheetRowUpdate, SheetRowIssue } from './ports';
import type { Services } from './services';
import type { Post, Settings, Topic } from './types';
import { safeErrorMessage } from './errors';

export interface SyncResult {
  sheetLabel: string;
  eligibleRows: number;
  imported: number;
  duplicates: number;
  skippedHandled: number;
  issues: SheetRowIssue[];
}

/**
 * Pull eligible rows from Google Sheets into content_topics.
 * Duplicate rows (same date + topic) are ignored, and already-handled rows are skipped,
 * which is what makes multiple sync runs safe.
 */
export async function syncTopicsFromSheet(services: Services, log: Logger): Promise<SyncResult> {
  const snapshot = await services.sheets.readRows();

  const seen = new Set<string>();
  const candidates = snapshot.rows.filter((row) => {
    const key = `${row.date}|${row.topic.trim().toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const { inserted, skipped } = await services.db.upsertTopics(
    candidates.map((row) => ({
      sheetRowNumber: row.rowNumber,
      topicDate: row.date,
      topic: row.topic,
      contentType: row.contentType,
      keyPoints: row.keyPoints,
      targetAudience: row.targetAudience,
    })),
  );

  const result: SyncResult = {
    sheetLabel: snapshot.sheetLabel,
    eligibleRows: snapshot.rows.length,
    imported: inserted,
    duplicates: skipped,
    skippedHandled: snapshot.rows.length === 0 ? 0 : snapshot.rows.length - candidates.length,
    issues: snapshot.issues,
  };

  await log.info('sheets.sync.completed', `Synced ${snapshot.sheetLabel}`, {
    eligible: result.eligibleRows,
    imported: result.imported,
    duplicates: result.duplicates,
    issues: result.issues.length,
  });

  if (snapshot.issues.length > 0) {
    await log.warn(
      'sheets.sync.issues',
      `${snapshot.issues.length} sheet row(s) could not be used`,
      {
        issues: snapshot.issues.slice(0, 20),
      },
    );
  }

  return result;
}

export function generationSheetUpdate(
  topic: Topic,
  post: Post,
  settings: Settings,
): SheetRowUpdate | null {
  if (topic.sheetRowNumber === null) return null;
  return {
    rowNumber: topic.sheetRowNumber,
    status: 'Generated',
    generatedPost: post.fullText,
    hashtags: post.hashtags.join(' '),
    approval: 'Pending',
    publishTime: settings.publishTime,
  };
}

export function approvalSheetUpdate(
  topic: Topic | null,
  action: 'approve' | 'reject',
): SheetRowUpdate | null {
  if (!topic || topic.sheetRowNumber === null) return null;
  return {
    rowNumber: topic.sheetRowNumber,
    status: action === 'approve' ? 'Approved' : 'Rejected',
    approval: action === 'approve' ? 'Approved' : 'Rejected',
  };
}

export function publishedSheetUpdate(
  topic: Topic | null,
  url: string | null,
  status: string,
): SheetRowUpdate | null {
  if (!topic || topic.sheetRowNumber === null) return null;
  return {
    rowNumber: topic.sheetRowNumber,
    status,
    ...(url ? { publishedUrl: url } : {}),
  };
}

/** Sheet writes are secondary: failures are logged, never allowed to corrupt pipeline state. */
export async function safeSheetUpdate(
  services: Services,
  log: Logger,
  update: SheetRowUpdate | null,
  event: string,
): Promise<boolean> {
  if (!update) return false;
  try {
    await services.sheets.updateRows([update]);
    await log.info(event, 'Google Sheet updated', { row: update.rowNumber });
    return true;
  } catch (error) {
    await log.error(`${event}.failed`, `Google Sheet update failed: ${safeErrorMessage(error)}`, {
      row: update.rowNumber,
    });
    return false;
  }
}
