'use client';

import * as React from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import type { TopicDto } from '@/lib/types';
import {
  Alert,
  Button,
  Card,
  CardContent,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Skeleton,
  Textarea,
  IconAdd,
  IconAi,
  IconRefresh,
} from '@/ui';
import { StatusBadge } from '@/components/status-badge';
import { GapNotice } from '@/components/gap-notice';
import { useToast } from '@/components/toast';

interface SyncResult {
  sheetLabel: string;
  eligibleRows: number;
  imported: number;
  duplicates: number;
  issues: Array<{ rowNumber: number; reason: string }>;
}

export default function QueuePage() {
  const { data, error, loading, reload } = useApi<{ topics: TopicDto[] }>(
    '/content/topics?status=pending,failed,claimed,generated&limit=100',
  );
  const { busy, run } = useAction();
  const { toast } = useToast();
  const [addOpen, setAddOpen] = React.useState(false);

  React.useEffect(() => {
    if (new URLSearchParams(window.location.search).get('new') === '1') setAddOpen(true);
  }, []);
  const [syncResult, setSyncResult] = React.useState<SyncResult | null>(null);
  // Only the gaps come from the calendar here; the planner itself lives on /calendar so the
  // queue page does not pay for its bundle.
  const calendar = useApi<{ gaps: string[] }>('/calendar');
  const [form, setForm] = React.useState({
    topicDate: new Date().toISOString().slice(0, 10),
    topic: '',
    contentType: 'insight',
    keyPoints: '',
    targetAudience: '',
  });

  const syncFromSheet = () =>
    run(
      () => api.post<SyncResult>('/content/sync'),
      (result) => {
        setSyncResult(result);
        toast(`Synced "${result.sheetLabel}": ${result.imported} new topic(s).`, 'success');
        reload();
      },
      (message) => toast(message, 'error'),
    );

  const generateNow = () =>
    run(
      () => api.post<{ result: { status: string; reason?: string } }>('/content/generate', {}),
      (result) => {
        toast(
          `Generation: ${result.result.status}${result.result.reason ? ` — ${result.result.reason}` : ''}`,
          'success',
        );
        reload();
      },
      (message) => toast(message, 'error'),
    );

  /**
   * Phase 7: a near-duplicate comes back as 409 with the earlier topic named. Instead of a toast the
   * owner never reads, the dialog switches to a confirmation - the repeat can still be added, but on
   * purpose, with the earlier topic visible.
   */
  const [duplicate, setDuplicate] = React.useState<{ message: string; of: string } | null>(null);

  const submitTopic = (allowDuplicate: boolean) =>
    run(
      () =>
        api.post<{ topic: { id: string; topicDate: string }; alreadyExists?: boolean }>('/content/topics', {
          topicDate: form.topicDate,
          topic: form.topic,
          contentType: form.contentType,
          keyPoints: form.keyPoints || null,
          targetAudience: form.targetAudience || null,
          ...(allowDuplicate ? { allowDuplicate: true } : {}),
        }),
      (result) => {
        // Phase 8: "Add anyway" can legitimately add nothing (the exact topic is already queued for
        // that date). Saying "added" then would be a lie, so the row is named and the list reloads.
        toast(
          result.alreadyExists
            ? `Already in the queue for ${result.topic.topicDate} — nothing added.`
            : 'Topic added to the queue.',
          result.alreadyExists ? 'info' : 'success',
        );
        setDuplicate(null);
        setAddOpen(false);
        setForm((current) => ({ ...current, topic: '', keyPoints: '', targetAudience: '' }));
        reload();
      },
      (message, error) => {
        if (error?.code === 'DUPLICATE_TOPIC') {
          setDuplicate({
            message,
            of: String(error.details?.duplicateOf ?? 'an earlier topic'),
          });
          return;
        }
        toast(message, 'error');
      },
    );

  const addTopic = () => submitTopic(false);

  // Editing the topic clears the warning: the new text deserves its own check.
  React.useEffect(() => {
    setDuplicate(null);
  }, [form.topic]);

  const resetTopic = (topicId: string) =>
    run(
      () => api.patch(`/content/topics/${topicId}`, { status: 'pending' }),
      () => {
        toast('Topic reset to pending.', 'success');
        reload();
      },
      (message) => toast(message, 'error'),
    );

  return (
    <div className="space-y-3">
      <Alert tone="info" title="Google Sheets is the planning interface">
        Rows with a DATE, a TOPIC and STATUS = Pending (or blank) are pulled in automatically. Rows
        already generated, approved or published are skipped, so nothing is processed twice.
      </Alert>

      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" loading={busy} onClick={syncFromSheet}>
          <IconRefresh className="h-4 w-4" aria-hidden /> Sync sheet
        </Button>
        <Button variant="outline" loading={busy} onClick={generateNow}>
          <IconAi className="h-4 w-4" aria-hidden /> Generate now
        </Button>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button className="h-11 w-full sm:flex-1" onClick={() => setAddOpen(true)}>
          <IconAdd className="h-4 w-4" aria-hidden /> Add topic manually
        </Button>
        <Link href="/calendar/" className="flex-1">
          <Button variant="outline" className="h-11 w-full sm:h-10">
            <IconAi className="h-4 w-4" aria-hidden /> Plan next week
          </Button>
        </Link>
      </div>

      <GapNotice gaps={calendar.data?.gaps ?? []} />

      {syncResult ? (
        <Card>
          <CardContent className="space-y-1 p-3.5 text-[13px]">
            <p className="font-medium">
              {syncResult.sheetLabel}: {syncResult.imported} imported, {syncResult.duplicates}{' '}
              already known
            </p>
            {syncResult.issues.length > 0 ? (
              <ul className="list-disc space-y-0.5 pl-4 text-[12px] text-warning-foreground">
                {syncResult.issues.slice(0, 6).map((issue) => (
                  <li key={`${issue.rowNumber}-${issue.reason}`}>
                    Row {issue.rowNumber}: {issue.reason}
                  </li>
                ))}
              </ul>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {error ? (
        <Alert tone="error" title="Could not load the queue">
          {error}
        </Alert>
      ) : null}

      {loading && !data ? <Skeleton className="h-32 w-full" /> : null}

      {data && data.topics.length === 0 ? (
        <EmptyState
          title="Queue is empty"
          description="Add a topic manually or sync your Google Sheet. Each publishing day uses the first pending topic for that date."
          action={
            <Button size="sm" className="h-11 sm:h-9" onClick={() => setAddOpen(true)}>
              Add topic
            </Button>
          }
        />
      ) : null}

      <div className="space-y-2.5">
        {(data?.topics ?? []).map((topic) => (
          <Card key={topic.id}>
            <CardContent className="space-y-1.5 p-3.5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium text-muted-foreground">{topic.topicDate}</p>
                <StatusBadge status={topic.status} />
              </div>
              <p className="break-words text-[13px] font-medium">{topic.topic}</p>
              <p className="text-[11px] text-muted-foreground">
                {topic.contentType}
                {topic.sheetRowNumber ? ` · sheet row ${topic.sheetRowNumber}` : ' · manual'}
                {topic.attempts > 0 ? ` · ${topic.attempts} attempt(s)` : ''}
              </p>
              {topic.lastError ? (
                <p className="break-words rounded bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
                  {topic.lastError}
                </p>
              ) : null}
              {topic.status === 'failed' ? (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={busy}
                  onClick={() => resetTopic(topic.id)}
                >
                  Reset to pending
                </Button>
              ) : null}
            </CardContent>
          </Card>
        ))}
      </div>

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add topic">
        <div className="space-y-3">
          <Field
            label="Date"
            htmlFor="topic-date"
            hint="The scheduler uses this date's pending topic."
          >
            <Input
              id="topic-date"
              type="date"
              value={form.topicDate}
              onChange={(event) => setForm({ ...form, topicDate: event.target.value })}
            />
          </Field>
          <Field label="Topic" htmlFor="topic-title">
            <Input
              id="topic-title"
              value={form.topic}
              placeholder="Idempotency keys for agent tool calls"
              onChange={(event) => setForm({ ...form, topic: event.target.value })}
            />
          </Field>
          <Field label="Content type" htmlFor="topic-type">
            <Select
              id="topic-type"
              value={form.contentType}
              onChange={(event) => setForm({ ...form, contentType: event.target.value })}
            >
              {['insight', 'story', 'how-to', 'opinion', 'case-note', 'list', 'question'].map(
                (type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ),
              )}
            </Select>
          </Field>
          <Field
            label="Key points"
            htmlFor="topic-points"
            hint="Only real facts you want included. The AI never invents metrics."
          >
            <Textarea
              id="topic-points"
              value={form.keyPoints}
              rows={4}
              placeholder="What actually happened, what you tried, what changed."
              onChange={(event) => setForm({ ...form, keyPoints: event.target.value })}
            />
          </Field>
          <Field label="Target audience" htmlFor="topic-audience">
            <Input
              id="topic-audience"
              value={form.targetAudience}
              placeholder="Engineers building agents"
              onChange={(event) => setForm({ ...form, targetAudience: event.target.value })}
            />
          </Field>
          {duplicate ? (
            <Alert tone="warning" title="This looks like a repeat">
              <p>{duplicate.message}</p>
              <p className="mt-1">
                Same idea, so it was not added. You can still keep it if this time the angle really is
                different.
              </p>
            </Alert>
          ) : null}

          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <Button
              variant="ghost"
              onClick={() => {
                setDuplicate(null);
                setAddOpen(false);
              }}
            >
              Cancel
            </Button>
            {duplicate ? (
              <Button loading={busy} onClick={() => submitTopic(true)}>
                Add anyway
              </Button>
            ) : (
              <Button loading={busy} disabled={form.topic.trim().length < 5} onClick={addTopic}>
                Add topic
              </Button>
            )}
          </div>
        </div>
      </Modal>
    </div>
  );
}
