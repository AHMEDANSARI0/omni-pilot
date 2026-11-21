'use client';

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  IconAi,
  IconClock,
  IconMail,
  IconPublish,
  IconSheets,
  IconSuccess,
  IconWarning,
  IconTile,
  type IconComponent,
} from '@/ui';
import { relativeTime } from '@/lib/utils';
import type { LogDto } from '@/lib/types';

const LABELS: Record<string, string> = {
  'generation.started': 'Generation started',
  'generation.completed': 'Post generated',
  'generation.topic_claimed': 'Topic claimed',
  'generation.no_topic': 'No topic for today',
  'generation.failed': 'Generation failed',
  'generation.duplicate': 'Day already generated',
  'generation.sheet_updated': 'Sheet updated',
  'generation.attempt_limit': 'Daily attempts exhausted',
  'approval.sent': 'Approval email sent',
  'approval.approved': 'Post approved',
  'approval.rejected': 'Post rejected',
  'approval.expired': 'Approval expired',
  'approval.reminder_sent': 'Reminder sent',
  'email.sent': 'Email sent',
  'email.failed': 'Email failed',
  'publish.started': 'Publishing started',
  'publish.succeeded': 'Published to LinkedIn',
  'publish.failed': 'Publishing failed',
  'publish.retry_scheduled': 'Retry scheduled',
  'publish.manual_required': 'Manual publish required',
  'publish.manual_recorded': 'Manual publish recorded',
  'publish.manual_sheet_updated': 'Sheet updated',
  'publish.already_published': 'Already published',
  'sheets.sync.completed': 'Sheet synced',
  'sheets.write.failed': 'Sheet write failed',
  'scheduler.tick': 'Scheduler tick',
  'scheduler.recovered': 'Stuck job recovered',
  'integration.linkedin.expiring': 'LinkedIn token expiring',
  'cron.error': 'Cron failed',
};

function appearanceFor(
  event: string,
  level: string,
): {
  icon: IconComponent;
  tone: 'indigo' | 'green' | 'amber' | 'red' | 'blue' | 'violet' | 'slate';
} {
  if (level === 'error') return { icon: IconWarning, tone: 'red' };
  if (level === 'warn') return { icon: IconWarning, tone: 'amber' };
  if (event.startsWith('approval')) return { icon: IconSuccess, tone: 'green' };
  if (event.startsWith('generation')) return { icon: IconAi, tone: 'indigo' };
  if (event.startsWith('email')) return { icon: IconMail, tone: 'violet' };
  if (event.startsWith('publish')) return { icon: IconPublish, tone: 'blue' };
  if (event.startsWith('sheets')) return { icon: IconSheets, tone: 'amber' };
  return { icon: IconClock, tone: 'slate' };
}

export function ActivityFeed({
  logs,
  limit = 6,
  className,
}: {
  logs: LogDto[];
  limit?: number;
  className?: string;
}) {
  const items = logs.slice(0, limit);

  return (
    <Card className={className}>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Recent activity</CardTitle>
        <a
          href="/settings/?tab=logs"
          className="flex min-h-11 items-center px-1 text-[12px] font-medium text-accent-strong hover:text-accent-strong/80"
        >
          View all
        </a>
      </CardHeader>
      <CardContent className="pt-3">
        {items.length === 0 ? (
          <p className="py-6 text-center text-[12.5px] text-muted-foreground">
            No activity recorded yet.
          </p>
        ) : (
          <ul className="-mx-1 divide-y divide-ink/[0.07]">
            {items.map((log) => {
              const { icon: Icon, tone } = appearanceFor(log.event, log.level);
              return (
                <li key={log.id} className="flex items-start gap-2.5 px-1 py-2.5">
                  <IconTile tone={tone} size="sm">
                    <Icon aria-hidden />
                  </IconTile>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12.5px] font-medium text-foreground">
                      {LABELS[log.event] ?? log.event}
                    </p>
                    {log.message ? (
                      <p className="line-clamp-1 text-[11.5px] text-muted-foreground">
                        {log.message}
                      </p>
                    ) : null}
                  </div>
                  <span className="shrink-0 pt-0.5 text-[10.5px] text-muted-foreground">
                    {relativeTime(log.createdAt)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
