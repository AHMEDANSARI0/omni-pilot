'use client';

import * as React from 'react';
import { IconClose } from '../icons';
import { IconButton } from '../primitives';
import { useFocusTrap, useScrollLock } from './sidebar-state';

/**
 * Phone/tablet navigation sheet (< lg only).
 *
 * Behaviours that make it usable rather than decorative:
 *   - backdrop click, the close button and Escape all close it
 *   - focus moves into the sheet and Tab cycles inside it (focus trap)
 *   - the page behind cannot scroll (scroll lock, no layout jump)
 *   - it is not rendered at all when closed, so the desktop bundle never pays for it
 */
export function Drawer({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  useScrollLock(open);
  useFocusTrap(panelRef, open, onClose);

  React.useEffect(() => {
    if (open) return;
    const opener = document.querySelector<HTMLElement>('[data-shell="menu-button"]');
    return () => opener?.focus({ preventScroll: true });
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      <button
        type="button"
        aria-label="Close navigation menu"
        onClick={onClose}
        data-shell="drawer-backdrop"
        className="absolute inset-0 h-full w-full cursor-default bg-ink/30 backdrop-blur-sm animate-fade-in"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        data-shell="drawer-panel"
        className="absolute inset-y-0 left-0 flex w-[min(86vw,320px)] animate-fade-in flex-col p-2 pt-[max(0.5rem,env(safe-area-inset-top))] pb-[max(0.5rem,env(safe-area-inset-bottom))]"
      >
        {children}
        {/* Visible close affordance: the backdrop and Escape also work, but a tap target is kinder. */}
        <IconButton
          label="Close navigation menu"
          onClick={onClose}
          className="absolute right-3 top-3 z-10 bg-white/80"
        >
          <IconClose className="h-4 w-4" aria-hidden />
        </IconButton>
      </div>
    </div>
  );
}
