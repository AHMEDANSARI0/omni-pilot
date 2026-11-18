import type { ISODate, ISOInstant } from './types';

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = partsFormatter(timeZone).formatToParts(instant);
  const lookup = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value;
    return value ? Number(value) : 0;
  };
  return {
    year: lookup('year'),
    month: lookup('month'),
    day: lookup('day'),
    hour: lookup('hour'),
    minute: lookup('minute'),
    second: lookup('second'),
  };
}

/** Offset (ms) that must be added to the UTC instant to obtain the wall clock in `timeZone`. */
export function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, 0);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

export function localDate(instant: Date, timeZone: string): ISODate {
  const p = zonedParts(instant, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Local wall-clock time as HH:MM in the given timezone. */
export function localTime(instant: Date, timeZone: string): string {
  const p = zonedParts(instant, timeZone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** ISO weekday: 1 = Monday ... 7 = Sunday, evaluated in the given timezone. */
export function localWeekday(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const day = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return day === 0 ? 7 : day;
}

/**
 * Convert a wall-clock time in `timeZone` to the matching UTC instant.
 * Runs the offset lookup twice so DST transitions resolve to the correct instant.
 */
export function zonedTimeToInstant(date: ISODate, time: string, timeZone: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  if (!year || !month || !day || hour === undefined || minute === undefined) {
    throw new Error(`Invalid date/time: ${date} ${time}`);
  }
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const firstOffset = timeZoneOffsetMs(new Date(guess), timeZone);
  let timestamp = guess - firstOffset;
  const secondOffset = timeZoneOffsetMs(new Date(timestamp), timeZone);
  if (secondOffset !== firstOffset) timestamp = guess - secondOffset;
  return new Date(timestamp);
}

export function addDays(date: ISODate, days: number): ISODate {
  const [year, month, day] = date.split('-').map(Number);
  const next = new Date(Date.UTC(year!, month! - 1, day! + days));
  return isoDate(next);
}

export function isoDate(date: Date): ISODate {
  return date.toISOString().slice(0, 10);
}

export function isoInstant(date: Date): ISOInstant {
  return date.toISOString();
}

export function addMinutes(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * 60_000);
}

export function addHours(instant: Date, hours: number): Date {
  return new Date(instant.getTime() + hours * 3_600_000);
}

export function diffMs(a: Date, b: Date): number {
  return a.getTime() - b.getTime();
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
