import Link from 'next/link';
import { Button } from '@/ui';

/**
 * "N publishing days have no topic yet" - a link, not an action, so pages that only need to
 * point at the planner do not have to load the planner bundle.
 */
export function GapNotice({ gaps }: { gaps: string[] }) {
  if (gaps.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-warm/60 bg-warm/25 px-3 py-2">
      <p className="text-[12px] text-foreground">
        <span className="font-semibold">{gaps.length} publishing day(s)</span> have no topic yet (
        {gaps.slice(0, 3).join(', ')}
        {gaps.length > 3 ? '…' : ''})
      </p>
      <Link href="/calendar/">
        <Button size="sm" variant="outline" className="h-11 sm:h-9">
          Plan in the calendar
        </Button>
      </Link>
    </div>
  );
}
