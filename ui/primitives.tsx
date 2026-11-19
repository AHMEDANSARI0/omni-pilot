'use client';

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn';

/* ------------------------------------------------------------------ surfaces */

export function Card({
  className,
  inset = false,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { inset?: boolean }) {
  return (
    <div
      className={cn(
        'rounded-3xl text-card-foreground',
        inset ? 'glass-sunken' : 'glass',
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
  return (
    <p
      className={cn('text-[12.5px] leading-relaxed text-muted-foreground', className)}
      {...props}
    />
  );
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-4 pt-3 lg:p-5 lg:pt-3', className)} {...props} />;
}

export function PageHeader({
  title,
  subtitle,
  eyebrow,
  actions,
  className,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  eyebrow?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between',
        className,
      )}
    >
      <div className="min-w-0">
        {eyebrow ? (
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="text-balance text-[23px] font-semibold leading-tight tracking-tight sm:text-[27px]">
          {title}
        </h1>
        {subtitle ? (
          <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-muted-foreground">
            {subtitle}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------- buttons */

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-[13.5px] font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent disabled:pointer-events-none disabled:opacity-45 active:scale-[0.985]',
  {
    variants: {
      variant: {
        default: 'ink-pill hover:bg-ink/90',
        secondary: 'glass text-secondary-foreground hover:bg-white/80 hover:shadow-glass',
        outline:
          'border border-white/70 bg-white/55 text-foreground backdrop-blur-md hover:bg-white/80',
        ghost: 'text-muted-foreground hover:bg-ink/5 hover:text-foreground',
        subtle: 'bg-primary-soft text-accent-foreground hover:bg-primary-soft/80',
        destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
        success: 'bg-accent-strong text-white shadow-sm hover:bg-accent-strong/90',
      },
      size: {
        default: 'h-11 px-5',
        // 44px on touch (phones), 36px once there is a pointer - the Responsive rule.
        sm: 'h-11 px-3.5 text-[13px] sm:h-9',
        lg: 'h-12 px-6 text-[15px]',
        icon: 'h-11 w-11 sm:h-10 sm:w-10',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, loading, children, disabled, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <span
          aria-hidden
          className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      ) : null}
      {children}
    </button>
  ),
);
Button.displayName = 'Button';

export { buttonVariants };

/** Square, glassy icon-only button (toolbars, card corners). */
export function IconButton({
  className,
  label,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-white/70 bg-white/55 text-muted-foreground backdrop-blur-md transition-colors hover:bg-white/85 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 sm:h-9 sm:w-9',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------- badges */

const badgeTones = {
  neutral: 'bg-ink/[0.06] text-muted-foreground',
  indigo: 'bg-primary-soft text-accent-foreground',
  blue: 'bg-[hsl(206_80%_94%)] text-[hsl(208_70%_30%)]',
  green: 'bg-primary-soft text-accent-strong',
  amber: 'bg-warm/45 text-[hsl(24_70%_32%)]',
  red: 'bg-destructive/12 text-[hsl(6_70%_38%)]',
  violet: 'bg-[hsl(268_46%_94%)] text-[hsl(268_38%_38%)]',
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
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11.5px] font-medium leading-5',
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
  indigo: 'bg-primary-soft text-accent-strong',
  green: 'bg-primary-soft text-accent-strong',
  amber: 'bg-warm/50 text-[hsl(22_72%_34%)]',
  red: 'bg-destructive/12 text-destructive',
  blue: 'bg-[hsl(206_80%_94%)] text-[hsl(208_70%_32%)]',
  violet: 'bg-[hsl(268_46%_94%)] text-[hsl(268_38%_40%)]',
  slate: 'bg-ink/[0.06] text-ink/70',
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
    sm: 'h-8 w-8 rounded-xl [&>svg]:h-4 [&>svg]:w-4',
    md: 'h-10 w-10 rounded-2xl [&>svg]:h-[18px] [&>svg]:w-[18px]',
    lg: 'h-12 w-12 rounded-2xl [&>svg]:h-5 [&>svg]:w-5',
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

/* --------------------------------------------------------------------- forms */

const fieldBase =
  'w-full rounded-[var(--radius-field)] border border-white/75 bg-white/65 px-3.5 text-[16px] text-foreground shadow-[0_1px_0_rgba(255,255,255,0.6)_inset] backdrop-blur-md transition-colors placeholder:text-muted-foreground/75 focus-visible:border-accent/70 focus-visible:bg-white/85 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent/20 disabled:opacity-50 sm:text-[13.5px]';

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(fieldBase, 'flex h-11 py-2', className)} {...props} />;
}

export function Textarea({
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(fieldBase, 'flex min-h-[92px] py-2.5 leading-relaxed', className)}
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
    <select className={cn(fieldBase, 'flex h-11 appearance-none py-2 pr-8', className)} {...props}>
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
      className="group relative -m-2 inline-flex h-11 w-[60px] shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
    >
      <span
        aria-hidden
        className={cn(
          'relative flex h-6 w-11 items-center rounded-full border border-white/50 transition-colors',
          checked ? 'bg-ink' : 'bg-ink/15',
        )}
      >
        <span
          className={cn(
            'inline-block h-[18px] w-[18px] transform rounded-full bg-white shadow-sm transition-transform',
            checked ? 'translate-x-[22px]' : 'translate-x-[3px]',
          )}
        />
      </span>
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

/* ------------------------------------------------------------------ feedback */

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
    info: 'border-[hsl(206_80%_88%)] bg-[hsl(206_80%_96%)]/90 text-[hsl(208_70%_26%)]',
    success: 'border-primary/50 bg-primary-soft/90 text-accent-strong',
    warning: 'border-warm/70 bg-warm/35 text-[hsl(24_70%_28%)]',
    error: 'border-destructive/25 bg-destructive/10 text-[hsl(6_70%_34%)]',
  } as const;
  return (
    <div
      className={cn(
        'rounded-2xl border px-3.5 py-3 text-[12.5px] leading-relaxed backdrop-blur-sm',
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
  return <div className={cn('animate-pulse rounded-2xl bg-ink/[0.07]', className)} />;
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
    <div className="flex flex-col items-center rounded-3xl border border-dashed border-white/80 bg-white/40 px-5 py-9 text-center backdrop-blur-sm">
      {icon ? (
        <IconTile tone="indigo" size="lg" className="mb-3">
          {icon}
        </IconTile>
      ) : null}
      <p className="text-[14.5px] font-semibold text-foreground">{title}</p>
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
      <h2 className="text-[11.5px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
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
      className="no-scrollbar inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-full border border-white/70 bg-white/45 p-1 backdrop-blur-md"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            // 44 px on touch, compact from sm up (dashboard density on desktop).
            'min-h-[44px] min-w-[44px] whitespace-nowrap rounded-full px-3.5 text-[12px] font-medium transition-colors sm:min-h-0 sm:min-w-0 sm:py-1.5',
            value === option.value
              ? 'bg-white text-foreground shadow-sm'
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
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/25 backdrop-blur-sm sm:items-center sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="glass-strong animate-slide-up max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-[28px] p-4 sm:animate-fade-in sm:rounded-[28px] sm:p-5"
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-ink/15 sm:hidden" />
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[15.5px] font-semibold">{title}</h2>
            {description ? (
              <p className="mt-0.5 text-[12.5px] text-muted-foreground">{description}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-mr-1 -mt-1 rounded-full p-2 text-muted-foreground transition-colors hover:bg-ink/5 hover:text-foreground"
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
