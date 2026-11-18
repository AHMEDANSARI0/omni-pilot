'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

export { Button } from './button';

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'rounded-xl border border-border bg-card text-card-foreground shadow-card',
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('flex flex-col gap-1 p-4 pb-0 lg:p-5 lg:pb-0', className)} {...props} />
  );
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('text-[15px] font-semibold tracking-tight', className)} {...props} />;
}

export function CardDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-[12.5px] text-muted-foreground', className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-4 pt-3 lg:p-5 lg:pt-3', className)} {...props} />;
}

const badgeTones = {
  neutral: 'bg-muted text-muted-foreground',
  indigo: 'bg-primary-soft text-accent-foreground',
  blue: 'bg-info-soft text-info-foreground',
  green: 'bg-success-soft text-success-foreground',
  amber: 'bg-warning-soft text-warning-foreground',
  red: 'bg-danger-soft text-danger-foreground',
  violet: 'bg-violet-50 text-violet-700',
} as const;

export type BadgeTone = keyof typeof badgeTones;

export function Badge({
  tone = 'neutral',
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-[11.5px] font-medium leading-5',
        badgeTones[tone],
        className,
      )}
      {...props}
    />
  );
}

export function Dot({ className }: { className?: string }) {
  return <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full bg-current', className)} />;
}

const tileTones = {
  indigo: 'bg-primary-soft text-primary',
  green: 'bg-success-soft text-success',
  amber: 'bg-warning-soft text-warning',
  red: 'bg-danger-soft text-danger',
  blue: 'bg-info-soft text-info',
  violet: 'bg-violet-50 text-violet-600',
  slate: 'bg-muted text-muted-foreground',
} as const;

export function IconTile({
  tone = 'indigo',
  size = 'md',
  className,
  children,
}: {
  tone?: keyof typeof tileTones;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  children: React.ReactNode;
}) {
  const sizes = {
    sm: 'h-8 w-8 rounded-lg [&>svg]:h-4 [&>svg]:w-4',
    md: 'h-10 w-10 rounded-xl [&>svg]:h-[18px] [&>svg]:w-[18px]',
    lg: 'h-11 w-11 rounded-xl [&>svg]:h-5 [&>svg]:w-5',
  } as const;
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center',
        sizes[size],
        tileTones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'flex h-10 w-full rounded-lg border border-input bg-card px-3 py-2 text-[16px] text-foreground shadow-sm transition-colors placeholder:text-muted-foreground/80 focus-visible:border-primary/40 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/10 disabled:opacity-50 sm:text-[13.5px]',
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        'flex min-h-[88px] w-full rounded-lg border border-input bg-card px-3 py-2 text-[16px] leading-relaxed text-foreground shadow-sm transition-colors placeholder:text-muted-foreground/80 focus-visible:border-primary/40 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/10 disabled:opacity-50 sm:text-[13.5px]',
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('text-[13px] font-medium text-foreground', className)} {...props} />;
}

export function Select({
  className,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'flex h-10 w-full appearance-none rounded-lg border border-input bg-card px-3 py-2 text-[16px] text-foreground shadow-sm transition-colors focus-visible:border-primary/40 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/10 sm:text-[13.5px]',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}

export function Switch({
  checked,
  onCheckedChange,
  label,
  id,
}: {
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
  label?: string;
  id?: string;
}) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2',
        checked ? 'bg-primary' : 'bg-slate-200',
      )}
    >
      <span
        className={cn(
          'inline-block h-[18px] w-[18px] transform rounded-full bg-white shadow-sm transition-transform',
          checked ? 'translate-x-[22px]' : 'translate-x-[3px]',
        )}
      />
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-[11.5px] leading-relaxed text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function Alert({
  tone = 'info',
  title,
  children,
  className,
}: {
  tone?: 'info' | 'success' | 'warning' | 'error';
  title?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  const tones = {
    info: 'border-info/20 bg-info-soft text-info-foreground',
    success: 'border-success/20 bg-success-soft text-success-foreground',
    warning: 'border-warning/25 bg-warning-soft text-warning-foreground',
    error: 'border-danger/20 bg-danger-soft text-danger-foreground',
  } as const;
  return (
    <div
      className={cn(
        'rounded-lg border px-3.5 py-3 text-[12.5px] leading-relaxed',
        tones[tone],
        className,
      )}
    >
      {title ? <p className="mb-0.5 text-[13px] font-semibold">{title}</p> : null}
      {children}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-lg bg-muted', className)} />;
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-border bg-card px-5 py-8 text-center">
      {icon ? (
        <IconTile tone="indigo" size="lg" className="mb-3">
          {icon}
        </IconTile>
      ) : null}
      <p className="text-[14px] font-semibold text-foreground">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-[12.5px] leading-relaxed text-muted-foreground">
        {description}
      </p>
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function SectionTitle({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-2.5 flex items-center justify-between gap-2">
      <h2 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
        {children}
      </h2>
      {action}
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-muted/60 p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded-[7px] px-2.5 py-1 text-[12px] font-medium transition-colors',
            value === option.value
              ? 'bg-card text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 backdrop-blur-[2px] sm:items-center sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="animate-slide-up max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-border bg-card p-4 shadow-pop sm:animate-fade-in sm:rounded-2xl sm:p-5"
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-border sm:hidden" />
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold">{title}</h2>
            {description ? (
              <p className="mt-0.5 text-[12.5px] text-muted-foreground">{description}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-mr-1 -mt-1 rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <span aria-hidden className="text-[15px] leading-none">
              ✕
            </span>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
