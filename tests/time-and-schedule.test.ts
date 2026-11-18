import { describe, expect, it } from 'vitest';
import {
  localDate,
  localTime,
  localWeekday,
  timeZoneOffsetMs,
  zonedTimeToInstant,
  addDays,
} from '@/src/core/time';
import {
  generationDue,
  isPublishDay,
  nextSlot,
  publishRunAt,
  slotForDate,
} from '@/src/core/schedule';
import { defaultSettings } from '@/src/core/defaults';

const karachi = defaultSettings({
  ownerTimezone: 'Asia/Karachi',
  generationTime: '08:00',
  publishTime: '09:30',
  publishDays: [1, 2, 3, 4, 5],
});

describe('timezone helpers', () => {
  it('converts Karachi wall clock to UTC (+05:00, no DST)', () => {
    expect(zonedTimeToInstant('2026-11-16', '08:00', 'Asia/Karachi').toISOString()).toBe(
      '2026-11-16T03:00:00.000Z',
    );
    expect(timeZoneOffsetMs(new Date('2026-11-16T03:00:00Z'), 'Asia/Karachi')).toBe(5 * 3600_000);
  });

  it('handles a DST timezone in summer and winter', () => {
    expect(zonedTimeToInstant('2026-07-15', '09:00', 'America/New_York').toISOString()).toBe(
      '2026-07-15T13:00:00.000Z',
    );
    expect(zonedTimeToInstant('2026-01-15', '09:00', 'America/New_York').toISOString()).toBe(
      '2026-01-15T14:00:00.000Z',
    );
  });

  it('resolves wall times after the spring-forward transition', () => {
    expect(zonedTimeToInstant('2026-03-08', '09:00', 'America/New_York').toISOString()).toBe(
      '2026-03-08T13:00:00.000Z',
    );
  });

  it('reports the local date, time and ISO weekday', () => {
    const instant = new Date('2026-11-16T20:30:00Z');
    expect(localDate(instant, 'Asia/Karachi')).toBe('2026-11-17');
    expect(localTime(instant, 'Asia/Karachi')).toBe('01:30');
    expect(localWeekday(instant, 'Asia/Karachi')).toBe(2);
    expect(localWeekday(new Date('2026-11-16T03:00:00Z'), 'Asia/Karachi')).toBe(1);
    expect(localWeekday(new Date('2026-11-15T03:00:00Z'), 'Asia/Karachi')).toBe(7);
  });

  it('adds days across month boundaries', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });
});

describe('scheduling rules', () => {
  it('only treats configured weekdays as publish days', () => {
    expect(isPublishDay(karachi, '2026-11-16')).toBe(true);
    expect(isPublishDay(karachi, '2026-11-20')).toBe(true);
    expect(isPublishDay(karachi, '2026-11-21')).toBe(false);
    expect(isPublishDay(karachi, '2026-11-15')).toBe(false);
  });

  it('is not due before the generation time', () => {
    const before = new Date('2026-11-16T02:30:00Z'); // 07:30 Karachi
    const result = generationDue(karachi, before);
    expect(result.due).toBe(false);
    expect(result.reason).toContain('Scheduled for 08:00');
  });

  it('is due at and after the generation time', () => {
    expect(generationDue(karachi, new Date('2026-11-16T03:00:00Z')).due).toBe(true);
    expect(generationDue(karachi, new Date('2026-11-16T03:05:00Z')).due).toBe(true);
  });

  it('is not due on non-publish days', () => {
    const saturday = new Date('2026-11-21T04:00:00Z');
    expect(generationDue(karachi, saturday).due).toBe(false);
    expect(generationDue(karachi, saturday).reason).toContain('Not a scheduled publish day');
  });

  it('computes the next slot, skipping the weekend', () => {
    const fridayEvening = new Date('2026-11-20T15:00:00Z'); // 20:00 Karachi Friday
    const slot = nextSlot(karachi, fridayEvening);
    expect(slot?.localDate).toBe('2026-11-23');
    expect(slot?.generationAt).toBe('2026-11-23T03:00:00.000Z');
  });

  it('honours the daily publish time when approving early', () => {
    const approvedEarly = new Date('2026-11-16T03:20:00Z'); // 08:20 Karachi, before 09:30
    const runAt = publishRunAt(karachi, approvedEarly);
    expect(runAt.toISOString()).toBe('2026-11-16T04:30:00.000Z');
  });

  it('publishes immediately when the daily publish time has passed', () => {
    const approvedLate = new Date('2026-11-16T06:00:00Z'); // 11:00 Karachi
    expect(publishRunAt(karachi, approvedLate).toISOString()).toBe(approvedLate.toISOString());
  });

  it('publishes immediately when respectPublishTime is disabled', () => {
    const settings = { ...karachi, respectPublishTime: false };
    const approvedEarly = new Date('2026-11-16T03:20:00Z');
    expect(publishRunAt(settings, approvedEarly).toISOString()).toBe(approvedEarly.toISOString());
  });

  it('exposes generation and publish instants for a date', () => {
    const slot = slotForDate(karachi, '2026-11-16');
    expect(slot.generationAt).toBe('2026-11-16T03:00:00.000Z');
    expect(slot.publishAt).toBe('2026-11-16T04:30:00.000Z');
    expect(slot.isGenerationDay).toBe(true);
  });
});
