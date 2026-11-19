/**
 * Layout-only entry point (app shell). Keeps nav icons out of every page bundle.
 *
 * The shell is split into small files under `ui/shell/` (frame, rail, topbar, drawer,
 * sidebar state). This barrel keeps the import surface identical, so the application
 * layer still imports everything from '@/ui/shell'.
 */
export * from './shell/shell';
export * from './shell/sidebar';
export * from './shell/topbar';
export * from './nav';
