import type { DaySlots, ScheduledSlot, Settings } from './types';
import { addDays, localDate, localTime, localWeekday, zonedTimeToInstant } from './time';

export function isPublishDay(settings: Settings, dateISO: string): boolean {
  const [year, month, day] = dateISO.split('-').map(Number);
  const weekday = new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay();
  const isoWeekday = weekday === 0 ? 7 : weekday;
  return settings.publishDays.includes(isoWeekday);
}

/** Upper bound on slots per day; the database constraint allows the same range. */
export const MAX_SLOTS_PER_DAY = 5;

/**
 * The publishing times this workspace uses, in order.
 *
 * Phase 10: `publishTimes` is the source of truth once it has entries, and `publishTime` stays as slot 0
 * so a database written before the migration (or a settings row from an older dashboard) behaves exactly
 * as it did in Phase 9: one post per day at one time.
 */
export function slotTimes(settings: Settings): string[] {
  const list = (settings.publishTimes ?? [])
    .map((time) => time.trim())
    .filter((time) => /^\d{2}:\d{2}$/.test(time));
  const unique = [...new Set(list)].sort();
  if (unique.length === 0) return [settings.publishTime];
  return unique.slice(0, MAX_SLOTS_PER_DAY);
}

export function slotCount(settings: Settings): number {
  return slotTimes(settings).length;
}

/** Generation runs `leadMinutes` before each publish slot, never before the day starts. */
const GENERATION_LEAD_MINUTES = 150;

/**
 * When generation for one slot should start: the owner's `generationTime` for the first slot, then a
 * fixed lead before each later slot, so a 15:00 post is drafted before 15:00 and not before 08:00.
 */
export function generationTimeForSlot(settings: Settings, slotIndex: number): string {
  if (slotIndex <= 0) return settings.generationTime;
  const [hours, minutes] = slotTimes(settings)[slotIndex]!.split(':').map(Number);
  const total = Math.max(0, hours! * 60 + minutes! - GENERATION_LEAD_MINUTES);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Every slot of one local date. Order matches the publish times. */
export function slotsForDate(settings: Settings, dateISO: string): DaySlots {
  const isDay = isPublishDay(settings, dateISO);
  const slots: ScheduledSlot[] = slotTimes(settings).map((time, index) => ({
    localDate: dateISO,
    slotIndex: index,
    generationAt: zonedTimeToInstant(
      dateISO,
      generationTimeForSlot(settings, index),
      settings.ownerTimezone,
    ).toISOString(),
    publishAt: zonedTimeToInstant(dateISO, time, settings.ownerTimezone).toISOString(),
    isGenerationDay: isDay,
  }));
  return { localDate: dateISO, slots, isGenerationDay: isDay };
}

/** The first slot of a date. Kept for every caller that predates multiple posts per day. */
export function slotForDate(settings: Settings, dateISO: string): ScheduledSlot {
  return slotsForDate(settings, dateISO).slots[0]!;
}

/** Next allowed generation slot strictly after `now` (looks up to 8 days ahead). */
export function nextSlot(settings: Settings, now: Date): ScheduledSlot | null {
  let cursor = localDate(now, settings.ownerTimezone);
  for (let index = 0; index < 8; index += 1) {
    const day = slotsForDate(settings, cursor);
    if (day.isGenerationDay) {
      const upcoming = day.slots.find(
        (slot) => new Date(slot.generationAt).getTime() > now.getTime(),
      );
      if (upcoming) return upcoming;
    }
    cursor = addDays(cursor, 1);
  }
  return null;
}

export interface SlotDue {
  due: boolean;
  slot: ScheduledSlot;
  reason: string;
}

/**
 * Which slots of today are due on this tick, in order.
 *
 * A slot is due once its generation time has passed; a slot whose *publish* time has already passed is
 * skipped, because a draft that arrives after the moment it was supposed to go live is not a draft the
 * owner can use - the day is reported as missed instead of pretending it can still publish.
 */
export function dueSlots(settings: Settings, now: Date): { due: SlotDue[]; skipped: SlotDue[] } {
  const today = localDate(now, settings.ownerTimezone);
  const day = slotsForDate(settings, today);
  const due: SlotDue[] = [];
  const skipped: SlotDue[] = [];

  if (!day.isGenerationDay) {
    return {
      due,
      skipped: day.slots.map((slot) => ({ due: false, slot, reason: 'Not a scheduled publish day' })),
    };
  }

  for (const slot of day.slots) {
    const generationAt = new Date(slot.generationAt).getTime();
    const publishAt = new Date(slot.publishAt).getTime();
    if (now.getTime() < generationAt) {
      skipped.push({
        due: false,
        slot,
        reason: `Scheduled for ${generationTimeForSlot(settings, slot.slotIndex)} ${settings.ownerTimezone} (in ${Math.round(
          (generationAt - now.getTime()) / 60000,
        )} min)`,
      });
      continue;
    }
    if (now.getTime() >= publishAt) {
      skipped.push({
        due: false,
        slot,
        reason: `Publish time ${slotTimes(settings)[slot.slotIndex]} already passed on ${today}`,
      });
      continue;
    }
    due.push({
      due: true,
      slot,
      reason: `Past ${generationTimeForSlot(settings, slot.slotIndex)} ${settings.ownerTimezone} on ${today} (local time ${localTime(now, settings.ownerTimezone)})`,
    });
  }

  return { due, skipped };
}

export interface GenerationDue {
  due: boolean;
  slot: ScheduledSlot;
  /** Every due slot of the day, so a two-post day can generate both in one tick. */
  slots: ScheduledSlot[];
  reason: string;
}

/**
 * Whether today's generation should run on this tick. Deduplication (one successful run per
 * (date, slot)) is enforced separately by the database claim, so a "due" result here is safe to compute
 * on every 5-minute tick.
 */
export function generationDue(settings: Settings, now: Date): GenerationDue {
  const today = localDate(now, settings.ownerTimezone);
  const { due, skipped } = dueSlots(settings, now);
  if (due.length > 0) {
    return {
      due: true,
      slot: due[0]!.slot,
      slots: due.map((entry) => entry.slot),
      reason: due[0]!.reason,
    };
  }
  const first = skipped[0];
  const day = slotsForDate(settings, today);
  return {
    due: false,
    slot: day.slots[0]!,
    slots: [],
    reason: first?.reason ?? 'Nothing due',
  };
}

/**
 * When an approved post should go live. With respectPublishTime enabled a post approved before its
 * own slot waits for it; anything later publishes immediately.
 *
 * Phase 10: the slot is chosen by `slotIndex`, so a 15:00 post approved at 09:00 waits for 15:00 while a
 * 10:30 post approved at 09:00 waits for 10:30 - the two no longer share one daily publish time.
 */
export function publishRunAt(settings: Settings, approvedAt: Date, slotIndex = 0): Date {
  if (!settings.respectPublishTime) return approvedAt;
  const today = localDate(approvedAt, settings.ownerTimezone);
  const day = slotsForDate(settings, today);
  const slot = day.slots[slotIndex] ?? day.slots[0]!;
  const publishAt = new Date(slot.publishAt);
  return publishAt.getTime() > approvedAt.getTime() ? publishAt : approvedAt;
}

/** ms since epoch for the first generation slot of the local date of `now`. */
export function generationSlotMs(settings: Settings, now: Date): number {
  return new Date(
    slotForDate(settings, localDate(now, settings.ownerTimezone)).generationAt,
  ).getTime();
}

export { localWeekday };
