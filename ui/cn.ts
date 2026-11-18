import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Class helper used by the UI kit. Kept here so ui/ never imports from the app. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
