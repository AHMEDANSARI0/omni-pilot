import { describe, expect, it } from 'vitest';
import { parsePublishTime, parseSheetDate, parseSheetValues } from '@/src/core/sheets-parse';

const HEADER = [
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
];

describe('sheet date parsing', () => {
  it('parses Google Sheets serial numbers', () => {
    expect(parseSheetDate(46342)).toBe('2026-11-16');
  });
  it('parses ISO and day-first strings', () => {
    expect(parseSheetDate('2026-11-16')).toBe('2026-11-16');
    expect(parseSheetDate('16/11/2026')).toBe('2026-11-16');
    expect(parseSheetDate('16 Nov 2026')).toBe('2026-11-16');
  });
  it('rejects impossible dates', () => {
    expect(parseSheetDate('2026-02-30')).toBeNull();
    expect(parseSheetDate('31/31/2026')).toBeNull();
    expect(parseSheetDate('')).toBeNull();
    expect(parseSheetDate(null)).toBeNull();
  });
  it('parses publish times', () => {
    expect(parsePublishTime('09:30')).toBe('09:30');
    expect(parsePublishTime('9:30 AM')).toBe('09:30');
    expect(parsePublishTime('2:15 pm')).toBe('14:15');
    expect(parsePublishTime('nonsense')).toBeNull();
  });
});

describe('sheet value parsing', () => {
  it('reads eligible rows and maps columns by header name', () => {
    const parsed = parseSheetValues([
      HEADER,
      [
        '2026-11-16',
        'Idempotency for agent tools',
        'insight',
        'Retries duplicated calls',
        'Engineers',
        'Pending',
        '',
        '',
        '',
        '09:30',
        '',
      ],
      [
        '2026-11-18',
        'Retry design',
        'how-to',
        'Separate transport from business retries',
        'Backend devs',
        '',
        '',
        '',
        '',
        '',
        '',
      ],
    ]);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({
      rowNumber: 2,
      date: '2026-11-16',
      topic: 'Idempotency for agent tools',
      contentType: 'insight',
      publishTime: '09:30',
    });
    expect(parsed.issues).toEqual([]);
    expect(parsed.columnsMissing).toEqual([]);
    expect(parsed.headerRow).toBe(1);
  });

  it('tolerates header variations, extra columns and a title row', () => {
    const parsed = parseSheetValues([
      ['LinkedIn content plan'],
      ['Date', 'Topic', 'Type', 'Key points', 'Audience', 'Status', 'Approval'],
      [
        '2026-11-16',
        'API integration lessons',
        'story',
        'webhook retries',
        'developers',
        'Ready',
        '',
      ],
    ]);
    expect(parsed.headerRow).toBe(2);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.contentType).toBe('story');
  });

  it('skips rows that were already handled so they are never regenerated', () => {
    const parsed = parseSheetValues([
      HEADER,
      [
        '2026-11-16',
        'Already generated',
        'insight',
        '',
        '',
        'Generated',
        'post text',
        '#AI',
        'Pending',
        '',
        '',
      ],
      [
        '2026-11-17',
        'Already published',
        'insight',
        '',
        '',
        'Published',
        'post text',
        '#AI',
        'Approved',
        '',
        'https://linkedin.com/x',
      ],
      ['2026-11-18', 'Rejected earlier', 'insight', '', '', 'Pending', '', '', 'Rejected', '', ''],
      ['2026-11-19', 'Fresh topic', 'insight', '', '', 'Pending', '', '', '', '', ''],
    ]);
    expect(parsed.rows.map((row) => row.topic)).toEqual(['Fresh topic']);
    expect(parsed.skippedHandled).toBe(3);
  });

  it('reports invalid rows without failing the whole sync', () => {
    const parsed = parseSheetValues([
      HEADER,
      ['not-a-date', 'Bad date row', 'insight', '', '', 'Pending', '', '', '', '', ''],
      ['2026-11-16', '', 'insight', '', '', 'Pending', '', '', '', '', ''],
      ['2026-11-16', 'Good row', 'insight', '', '', 'Pending', '', '', '', '', ''],
      ['2026-11-17', 'Weird status', 'insight', '', '', 'Unknown state', '', '', '', '', ''],
    ]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.topic).toBe('Good row');
    expect(parsed.issues).toHaveLength(3);
    expect(parsed.issues[0]?.reason).toContain('Invalid or missing DATE');
  });

  it('fails with a clear message when required headers are missing', () => {
    const parsed = parseSheetValues([
      ['Title', 'Notes'],
      ['x', 'y'],
    ]);
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.issues[0]?.reason).toContain('Could not find required DATE and TOPIC headers');
    expect(parsed.columnsMissing).toEqual(['date', 'topic']);
  });

  it('handles an empty sheet', () => {
    const parsed = parseSheetValues([]);
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.issues[0]?.reason).toContain('Sheet is empty');
  });
});
