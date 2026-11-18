'use client';

import Link from 'next/link';
import { api } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import type { OverviewDto } from '@/lib/types';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  SectionTitle,
  Skeleton,
  IconAdd,
  IconApprovals,
  IconBrand,
  IconClock,
  IconError,
  IconNext,
  IconPosts,
  IconSuccess,
  IconTile,
} from '@/ui';
import {
  IntegrationRow,
  PostPreviewCard,
  ScheduleCard,
  StatCard,
} from '@/components/dashboard-cards';
import { ActivityChart } from '@/components/charts/activity-chart';
import { ActivityFeed } from '@/components/activity-feed';
import { useToast } from '@/components/toast';

export default function OverviewPage() {
  const { data, error, loading, reload } = useApi<OverviewDto>('/overview');
  const { busy, run } = useAction();
  const { toast } = useToast();

  const runNow = () =>
    run(
      () => api.post<{ generation: { reason: string } }>('/schedule/run', { force: true }),
      (result) => {
        toast(`Run complete: ${result.generation.reason}`, 'success');
        reload();
      },
      (message) => toast(message, 'error'),
    );

  if (loading && !data) {
    return (
      <div className="space-y-4 lg:space-y-5">
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:gap-4">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-[118px] w-full" />
          ))}
        </div>
        <div className="grid gap-4 lg:grid-cols-3 lg:gap-5">
          <Skeleton className="h-[320px] w-full lg:col-span-2" />
          <Skeleton className="h-[320px] w-full" />
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <Alert tone="error" title="Could not load the dashboard">
        {error}
      </Alert>
    );
  }

  if (!data) return null;

  const { stats, schedule, integrations, latestPosts, recentLogs, series, trend, upcomingTopics } =
    data;
  const timeZone = schedule.settings.ownerTimezone;

  const nextSlotLabel = schedule.nextSlot?.generationAt
    ? new Intl.DateTimeFormat('en-GB', {
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZone,
      }).format(new Date(schedule.nextSlot.generationAt))
    : null;

  return (
    <div className="space-y-4 lg:space-y-5">
      <Card className="relative overflow-hidden p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="mesh-orb flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-white/70">
              <IconBrand className="h-5 w-5 text-ink" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Welcome back
              </p>
              <h2 className="mt-0.5 text-balance text-[19px] font-semibold leading-tight tracking-tight sm:text-[21px]">
                {stats.pendingApprovals > 0
                  ? `${stats.pendingApprovals} post${stats.pendingApprovals > 1 ? 's' : ''} waiting for your call`
                  : 'Your pipeline is clear'}
              </h2>
              <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
                {nextSlotLabel ? `Next draft ${nextSlotLabel} (${timeZone}). ` : ''}
                Nothing publishes without your approval.
              </p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Link href="/approvals/">
              <Button size="sm" className="gap-1.5">
                <IconApprovals className="h-4 w-4" aria-hidden />
                Review approvals
              </Button>
            </Link>
            <Link href="/queue/?new=1">
              <Button size="sm" variant="outline" className="gap-1.5">
                <IconAdd className="h-4 w-4" aria-hidden />
                Add topic
              </Button>
            </Link>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:gap-4">
        <StatCard
          label="Generated"
          value={stats.total}
          icon={<IconPosts aria-hidden />}
          tone="indigo"
          href="/posts/"
          trend={trend.generated}
          hint="vs previous 7 days"
        />
        <StatCard
          label="Pending approval"
          value={stats.pendingApprovals}
          icon={<IconClock aria-hidden />}
          tone="amber"
          href="/approvals/"
          hint={stats.pendingApprovals > 0 ? 'needs your review' : 'all clear'}
        />
        <StatCard
          label="Published"
          value={stats.published}
          icon={<IconSuccess aria-hidden />}
          tone="green"
          href="/history/"
          trend={trend.published}
          hint={`of ${stats.total} generated`}
        />
        <StatCard
          label="Failed"
          value={stats.failed}
          icon={<IconError aria-hidden />}
          tone="red"
          href="/posts/?status=failed"
          hint={stats.failed > 0 ? 'open logs to retry' : 'nothing broken'}
        />
      </div>

      {stats.pendingApprovals > 0 ? (
        <div className="flex items-center gap-3 rounded-full border border-white/70 bg-warm/30 px-3.5 py-2.5 backdrop-blur-md">
          <IconTile tone="amber" size="sm">
            <IconClock aria-hidden />
          </IconTile>
          <p className="min-w-0 flex-1 text-[12.5px] leading-snug text-foreground">
            <span className="font-semibold">
              {stats.pendingApprovals} post{stats.pendingApprovals > 1 ? 's' : ''}
            </span>{' '}
            waiting for approval. Nothing publishes until you decide.
          </p>
          <Link
            href="/approvals/"
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-white/70 bg-white/70 px-3 py-1.5 text-[12px] font-medium text-foreground shadow-sm transition-colors hover:bg-white"
          >
            Review
            <IconNext className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3 lg:gap-5">
        <div className="lg:col-span-2">
          <ActivityChart series={series} />
        </div>
        <ScheduleCard
          nextRunAt={schedule.nextSlot?.generationAt ?? null}
          timeZone={timeZone}
          dueNow={schedule.generationDueNow}
          reason={schedule.generationReason}
          lastRunAt={schedule.schedulerState.lastGenerationAt}
          lastRunStatus={schedule.schedulerState.lastGenerationStatus}
          action={
            <Button className="w-full" size="sm" loading={busy} onClick={runNow}>
              Run pipeline now
            </Button>
          }
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3 lg:gap-5">
        <div className="space-y-2.5 lg:col-span-2">
          <SectionTitle
            action={
              <Link
                href="/posts/"
                className="text-[12px] font-medium text-accent-strong hover:text-accent-strong/80"
              >
                All posts
              </Link>
            }
          >
            Latest posts
          </SectionTitle>

          {latestPosts.length === 0 ? (
            <EmptyState
              icon={<IconPosts aria-hidden />}
              title="No posts yet"
              description="Add a topic to the queue (or sync your Google Sheet) and the scheduler will generate a post on your next publishing day."
              action={
                <Link href="/queue/?new=1">
                  <Button size="sm">Add your first topic</Button>
                </Link>
              }
            />
          ) : (
            <div className="space-y-2.5">
              {latestPosts.slice(0, 3).map((post) => (
                <PostPreviewCard key={post.id} post={post} timeZone={timeZone} />
              ))}
            </div>
          )}
        </div>

        <div className="space-y-4">
          <ActivityFeed logs={recentLogs} limit={6} />
          {upcomingTopics.length > 0 ? (
            <Card className="overflow-hidden">
              <div className="flex items-center justify-between px-4 pt-4 lg:px-5">
                <h3 className="text-[15px] font-semibold tracking-tight">Upcoming topics</h3>
                <Link
                  href="/queue/"
                  className="text-[12px] font-medium text-accent-strong hover:text-accent-strong/80"
                >
                  Queue
                </Link>
              </div>
              <ul className="mt-2 divide-y divide-ink/[0.07]">
                {upcomingTopics.map((topic) => (
                  <li key={topic.id} className="flex items-start gap-2 px-4 py-2.5 lg:px-5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12.5px] font-medium">{topic.topic}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {topic.topicDate} · {topic.contentType}
                      </p>
                    </div>
                    <span className="shrink-0 text-[10.5px] capitalize text-muted-foreground">
                      {topic.status}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      </div>

      <section>
        <SectionTitle
          action={
            <Link
              href="/settings/?tab=integrations"
              className="text-[12px] font-medium text-accent-strong hover:text-accent-strong/80"
            >
              Manage
            </Link>
          }
        >
          Integrations
        </SectionTitle>
        <Card className="divide-y divide-ink/[0.07] overflow-hidden">
          <IntegrationRow
            kind="sheets"
            name="Google Sheets"
            detail={
              integrations.googleSheets.connected
                ? integrations.googleSheets.sheetLabel
                : 'Connect to load topics automatically'
            }
            status={integrations.googleSheets.connected ? 'connected' : 'disconnected'}
            href="/settings/?tab=integrations"
          />
          <IntegrationRow
            kind="linkedin"
            name="LinkedIn"
            detail={
              integrations.linkedin.connected
                ? `${integrations.linkedin.label ?? 'Connected'}${integrations.linkedin.expiresAt ? ` · token expires ${integrations.linkedin.expiresAt.slice(0, 10)}` : ''}`
                : integrations.linkedin.needsReauth
                  ? 'Reconnect required to publish automatically'
                  : 'Not connected - manual publishing only'
            }
            status={
              integrations.linkedin.connected
                ? 'connected'
                : integrations.linkedin.needsReauth
                  ? 'needs_reauth'
                  : 'disconnected'
            }
            href="/settings/?tab=integrations"
          />
          <IntegrationRow
            kind="email"
            name="Email (Resend)"
            detail={
              integrations.email.connected
                ? integrations.email.fromEmail
                : 'Approval emails will not be sent'
            }
            status={integrations.email.connected ? 'connected' : 'disconnected'}
            href="/settings/?tab=integrations"
          />
          <IntegrationRow
            kind="ai"
            name="AI provider"
            detail={`${integrations.ai.provider} · ${integrations.ai.model}`}
            status="connected"
            href="/settings/?tab=ai"
          />
        </Card>
      </section>
    </div>
  );
}
