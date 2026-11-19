'use client';

import * as React from 'react';
import { api } from '@/lib/api';
import { useAction, useApi } from '@/lib/hooks';
import { formatDateTime } from '@/lib/utils';
import type { ScheduleDto, SettingsDto } from '@/lib/types';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
  Switch,
} from '@/ui';
import { useToast } from '../toast';

const TIMEZONES = [
  'Asia/Karachi',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Riyadh',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Asia/Singapore',
  'Australia/Sydney',
  'UTC',
];

const DAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 7, label: 'Sun' },
];

export function SchedulePanel({
  settings,
  onSaved,
}: {
  settings: SettingsDto;
  onSaved: () => void;
}) {
  const [form, setForm] = React.useState(settings);
  // Phase 10: publish times are a list. One entry is the old behaviour; the second is the whole feature.
  const times =
    form.publishTimes && form.publishTimes.length > 0 ? form.publishTimes : [form.publishTime];
  const { busy, run } = useAction();
  const { toast } = useToast();
  const schedule = useApi<ScheduleDto>('/settings/schedule');

  const save = () =>
    run(
      () =>
        api.patch<{ settings: SettingsDto }>('/settings', {
          ownerTimezone: form.ownerTimezone,
          generationTime: form.generationTime,
          publishTime: times[0],
          publishTimes: times,
          publishDays: form.publishDays,
          respectPublishTime: form.respectPublishTime,
          autoPublishOnApproval: form.autoPublishOnApproval,
          approvalTtlHours: Number(form.approvalTtlHours),
          emailNotifications: form.emailNotifications,
        }),
      () => {
        toast('Schedule saved.', 'success');
        onSaved();
        schedule.reload();
      },
      (message) => toast(message, 'error'),
    );

  const toggleDay = (day: number) =>
    setForm((current) => ({
      ...current,
      publishDays: current.publishDays.includes(day)
        ? current.publishDays.filter((value) => value !== day)
        : [...current.publishDays, day].sort(),
    }));

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader>
          <CardTitle>Daily schedule</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Field label="Timezone" htmlFor="tz" hint="All times below are in this timezone.">
            <Select
              id="tz"
              value={form.ownerTimezone}
              onChange={(event) => setForm({ ...form, ownerTimezone: event.target.value })}
            >
              {[...new Set([form.ownerTimezone, ...TIMEZONES])].map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </Select>
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <Field label="Generate at" htmlFor="gen-time" hint="Draft + approval email">
              <Input
                id="gen-time"
                type="time"
                value={form.generationTime}
                onChange={(event) => setForm({ ...form, generationTime: event.target.value })}
              />
            </Field>
            <Field
              label={times.length > 1 ? 'Publish at (first post)' : 'Publish at'}
              htmlFor="pub-time"
              hint={times.length > 1 ? 'Slot 1 of the day' : 'Earliest go-live'}
            >
              <Input
                id="pub-time"
                type="time"
                value={times[0]}
                onChange={(event) => {
                  const next = [event.target.value, ...times.slice(1)];
                  setForm({ ...form, publishTime: next[0]!, publishTimes: next });
                }}
              />
            </Field>
          </div>

          {/* Phase 10: more than one post a day. Each extra slot gets its own draft, approval and publish. */}
          <div className="space-y-2 rounded-xl border border-border bg-muted/30 p-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-[13px] font-medium">Posts per day</p>
                <p className="text-[12px] text-muted-foreground">
                  {times.length === 1
                    ? 'One post a day. Add a slot to draft and publish a second post later in the day.'
                    : `${times.length} posts a day. Each slot gets its own draft and its own approval.`}
                </p>
              </div>
              {times.length < 5 ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-11 shrink-0 sm:h-9"
                  onClick={() => {
                    // Default to a slot three hours after the last one, still inside the day.
                    const last = times[times.length - 1] ?? '10:30';
                    const [hours, minutes] = last.split(':').map(Number);
                    const nextHour = Math.min(23, (hours ?? 10) + 3);
                    const next = `${String(nextHour).padStart(2, '0')}:${String(minutes ?? 0).padStart(2, '0')}`;
                    setForm({ ...form, publishTimes: [...times, next] });
                  }}
                >
                  Add slot
                </Button>
              ) : null}
            </div>

            {times.length > 1
              ? times.slice(1).map((time, index) => (
                  <div key={`slot-${index + 1}`} className="flex items-end gap-2">
                    <Field
                      label={`Slot ${index + 2}`}
                      htmlFor={`pub-time-${index + 1}`}
                      hint="Its own draft + approval"
                    >
                      <Input
                        id={`pub-time-${index + 1}`}
                        type="time"
                        value={time}
                        onChange={(event) => {
                          const next = [...times];
                          next[index + 1] = event.target.value;
                          setForm({ ...form, publishTimes: next });
                        }}
                      />
                    </Field>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-11 shrink-0 sm:h-9"
                      aria-label={`Remove slot ${index + 2}`}
                      onClick={() =>
                        setForm({
                          ...form,
                          publishTimes: times.filter((_, position) => position !== index + 1),
                        })
                      }
                    >
                      Remove
                    </Button>
                  </div>
                ))
              : null}
          </div>

          <div className="space-y-1.5">
            <p className="text-[13px] font-medium">Publishing days</p>
            <div className="flex flex-wrap gap-1.5">
              {DAYS.map((day) => {
                const active = form.publishDays.includes(day.value);
                return (
                  <button
                    key={day.value}
                    type="button"
                    onClick={() => toggleDay(day.value)}
                    className={`h-11 w-12 rounded-lg border text-[12px] font-medium sm:h-9 ${
                      active
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border bg-card'
                    }`}
                  >
                    {day.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
            <div className="min-w-0">
              <p className="text-[13px] font-medium">Respect publish time</p>
              <p className="text-[11px] text-muted-foreground">
                Approvals before {form.publishTime} wait until then; later approvals publish
                immediately.
              </p>
            </div>
            <Switch
              checked={form.respectPublishTime}
              onCheckedChange={(value) => setForm({ ...form, respectPublishTime: value })}
            />
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
            <div className="min-w-0">
              <p className="text-[13px] font-medium">Publish automatically on approval</p>
              <p className="text-[11px] text-muted-foreground">
                Off means approved posts wait for a manual publish tap.
              </p>
            </div>
            <Switch
              checked={form.autoPublishOnApproval}
              onCheckedChange={(value) => setForm({ ...form, autoPublishOnApproval: value })}
            />
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
            <div className="min-w-0">
              <p className="text-[13px] font-medium">Email notifications</p>
              <p className="text-[11px] text-muted-foreground">
                Approval requests, receipts and failure alerts.
              </p>
            </div>
            <Switch
              checked={form.emailNotifications}
              onCheckedChange={(value) => setForm({ ...form, emailNotifications: value })}
            />
          </div>

          <Field label="Approval link validity (hours)" htmlFor="ttl">
            <Input
              id="ttl"
              type="number"
              min={1}
              max={336}
              value={form.approvalTtlHours}
              onChange={(event) =>
                setForm({ ...form, approvalTtlHours: Number(event.target.value) })
              }
            />
          </Field>

          <Button className="w-full" loading={busy} onClick={save}>
            Save schedule
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Execution status</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-[13px]">
          <p>
            Local time now:{' '}
            <span className="font-medium">
              {schedule.data?.localDate} {schedule.data?.localTime} ({form.ownerTimezone})
            </span>
          </p>
          <p>
            Next run:{' '}
            <span className="font-medium">
              {schedule.data?.nextSlot
                ? formatDateTime(schedule.data.nextSlot.generationAt, form.ownerTimezone)
                : 'No upcoming slot'}
            </span>
          </p>
          <p className="text-muted-foreground">{schedule.data?.generationReason}</p>
          <p className="text-muted-foreground">
            Last generation: {schedule.data?.schedulerState.lastGenerationStatus ?? 'never'}
            {schedule.data?.schedulerState.lastGenerationAt
              ? ` · ${formatDateTime(schedule.data.schedulerState.lastGenerationAt, form.ownerTimezone)}`
              : ''}
          </p>
          <p className="text-muted-foreground">
            Queued publishing jobs: {schedule.data?.queuedJobs ?? 0} (due now:{' '}
            {schedule.data?.dueJobs ?? 0})
          </p>
          <Alert tone="info">
            Cloudflare Cron runs every 5 minutes and decides in code whether anything is due, so
            timezone changes and DST are handled without touching the cron expression.
          </Alert>
        </CardContent>
      </Card>
    </div>
  );
}
