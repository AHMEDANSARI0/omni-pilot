'use client';

import Link from 'next/link';
import { cn } from '@/lib/utils';
import { NAV, isActive } from './nav';

export function MobileNav({ pathname }: { pathname: string }) {
  return (
    <nav
      aria-label="Primary"
      className="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card/95 backdrop-blur-md lg:hidden"
    >
      <div className="mx-auto grid max-w-lg grid-cols-6 px-1 pt-1">
        {NAV.map((item) => {
          const active = isActive(pathname, item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className="flex min-h-[54px] flex-col items-center justify-center gap-1 px-0.5 pb-1 text-[10px] font-medium"
            >
              <span
                className={cn(
                  'flex h-7 w-11 items-center justify-center rounded-lg transition-colors',
                  active ? 'bg-primary-soft text-primary' : 'text-muted-foreground',
                )}
              >
                <Icon className={cn('h-[19px] w-[19px]', active && 'stroke-[2.3]')} aria-hidden />
              </span>
              <span className={cn('truncate', active ? 'text-primary' : 'text-muted-foreground')}>
                {item.shortLabel}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
