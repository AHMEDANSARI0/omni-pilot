/**
 * PostPilot UI kit - the entry point pages and components import.
 *
 * Deliberately does NOT re-export the shell/layout: those pull in navigation and
 * every nav icon, which no individual page should pay for. The app shell imports
 * them from '@/ui/shell' instead.
 *
 * Re-theme the entire product from ui/tokens.css; swap icons in ui/icons.tsx.
 */
export * from './primitives';
export * from './icons';
export { theme, chartColors } from './theme';
export { cn } from './cn';
