import type { ScheduledSlot, Settings } from './types';
import { addDays, localDate, localTime, localWeekday, zonedTimeToInstant } from './time';

export function isPublishDay(settings: Settings, dateISO: string): boolean {
  const [year, month, day] = dateISO.split('-').map(Number);
  const weekday = new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay();
  const isoWeekday = weekday === 0 ? 7 : weekday;
  return settings.publishDays.includes(isoWeekday);
}

/** The generation/publish pair for a specific local date. */
export function slotForDate(settings: Settings, dateISO: string): ScheduledSlot {
  return {
    localDate: dateISO,
    generationAt: zonedTimeToInstant(
      dateISO,
      settings.generationTime,
      settings.ownerTimezone,
    ).toISOString(),
    publishAt: zonedTimeToInstant(
      dateISO,
      settings.publishTime,
      settings.ownerTimezone,
    ).toISOString(),
    isGenerationDay: isPublishDay(settings, dateISO),
  };
}

/** Next allowed generation slot strictly after `now` (looks up to 8 days ahead). */
export function nextSlot(settings: Settings, now: Date): ScheduledSlot | null {
  let cursor = localDate(now, settings.ownerTimezone);
  for (let index = 0; index < 8; index += 1) {
    const slot = slotForDate(settings, cursor);
    if (slot.isGenerationDay && new Date(slot.generationAt).getTime() > now.getTime()) return slot;
    cursor = addDays(cursor, 1);
  }
  return null;
}

export interface GenerationDue {
  due: boolean;
  slot: ScheduledSlot;
  reason: string;
}

/**
 * Whether today's generation should run on this tick. Deduplication (one successful run
 * per local date) is enforced separately by the database claim, so a "due" result here is
 * safe to compute on every 5-minute tick.
 */
export function generationDue(settings: Settings, now: Date): GenerationDue {
  const today = localDate(now, settings.ownerTimezone);
  const slot = slotForDate(settings, today);
  if (!slot.isGenerationDay) {
    return { due: false, slot, reason: 'Not a scheduled publish day' };
  }
  const generationAt = new Date(slot.generationAt);
  if (now.getTime() < generationAt.getTime()) {
    return {
      due: false,
      slot,
      reason: `Scheduled for ${settings.generationTime} ${settings.ownerTimezone} (in ${Math.round(
        (generationAt.getTime() - now.getTime()) / 60000,
      )} min)`,
    };
  }
  return {
    due: true,
    slot,
    reason: `Past ${settings.generationTime} ${settings.ownerTimezone} on ${today} (local time ${localTime(now, settings.ownerTimezone)})`,
  };
}

/**
 * When an approved post should go live. With respectPublishTime enabled a post approved
 * before the daily publish time waits for it; anything later publishes immediately.
 */
export function publishRunAt(settings: Settings, approvedAt: Date): Date {
  if (!settings.respectPublishTime) return approvedAt;
  const today = localDate(approvedAt, settings.ownerTimezone);
  const slot = slotForDate(settings, today);
  const publishAt = new Date(slot.publishAt);
  return publishAt.getTime() > approvedAt.getTime() ? publishAt : approvedAt;
}

/** ms since epoch for the daily generation slot of the local date of `now`. */
export function generationSlotMs(settings: Settings, now: Date): number {
  return new Date(
    slotForDate(settings, localDate(now, settings.ownerTimezone)).generationAt,
  ).getTime();
}

export { localWeekday };
