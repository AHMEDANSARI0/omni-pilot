'use client';

import * as React from 'react';

/**
 * Sidebar geometry, shared by the sidebar, the drawer and the shell.
 *
 * The width lives in CSS (`--sidebar-w` / `--sidebar-w-collapsed` in ui/tokens.css)
 * and is mirrored on <html data-sidebar="expanded|collapsed"> so the grid template
 * can react with pure CSS. React only owns the user's choice; it never animates.
 */

export type SidebarState = 'expanded' | 'collapsed';

const STORAGE_KEY = 'postpilot.sidebar';

export function readSidebarState(): SidebarState {
  if (typeof window === 'undefined') return 'expanded';
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'collapsed' ? 'collapsed' : 'expanded';
  } catch {
    return 'expanded';
  }
}

export function writeSidebarState(state: SidebarState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, state);
  } catch {
    /* private mode / quota - the choice simply does not persist */
  }
}

/** Mirrors the state onto <html> and returns it, so callers need no effect of their own. */
export function applySidebarState(state: SidebarState): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-sidebar', state);
}

export function nextSidebarState(state: SidebarState): SidebarState {
  return state === 'expanded' ? 'collapsed' : 'expanded';
}

/**
 * Locks page scroll while a drawer is open and restores it afterwards, without
 * letting the body jump when the scrollbar disappears.
 */
export function useScrollLock(active: boolean): void {
  React.useEffect(() => {
    if (!active) return;
    const { body } = document;
    const previousOverflow = body.style.overflow;
    const previousPadding = body.style.paddingRight;
    const gap = window.innerWidth - document.documentElement.clientWidth;
    body.style.overflow = 'hidden';
    if (gap > 0) body.style.paddingRight = `${gap}px`;
    return () => {
      body.style.overflow = previousOverflow;
      body.style.paddingRight = previousPadding;
    };
  }, [active]);
}

/** The first acceptable "go back" key: Escape closes, Tab stays inside the panel. */
export function useFocusTrap(
  containerRef: React.RefObject<HTMLElement | null>,
  active: boolean,
  onClose: () => void,
): void {
  React.useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const focusables = () =>
      Array.from(
        container.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.offsetParent !== null);

    const first = focusables()[0];
    first?.focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const head = items[0];
      const tail = items[items.length - 1];
      if (!head || !tail) return;
      if (event.shiftKey && document.activeElement === head) {
        event.preventDefault();
        tail.focus();
      } else if (!event.shiftKey && document.activeElement === tail) {
        event.preventDefault();
        head.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [active, containerRef, onClose]);
}
