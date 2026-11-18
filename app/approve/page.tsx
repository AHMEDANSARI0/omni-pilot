'use client';

import * as React from 'react';
import { api } from '@/lib/api';
import type { ApprovalPreviewDto, DecisionResponseDto } from '@/lib/types';
import {
  Alert,
  Button,
  Card,
  CardContent,
  Skeleton,
  Textarea,
  IconApprove,
  IconBrand,
  IconClose,
  IconSecurity,
} from '@/ui';

export default function ApprovalPage() {
  const [token, setToken] = React.useState<string | null>(null);
  const [intent, setIntent] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<ApprovalPreviewDto | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [decision, setDecision] = React.useState<DecisionResponseDto | null>(null);
  const [showReject, setShowReject] = React.useState(false);
  const [note, setNote] = React.useState('');

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const value = params.get('token');
    setIntent(params.get('intent'));
    setToken(value);
    if (!value) {
      setLoading(false);
      setError('This link is missing its approval token.');
      return;
    }
    api
      .public<ApprovalPreviewDto>(`/public/approvals/${encodeURIComponent(value)}`)
      .then((result) => {
        setPreview(result);
        setShowReject(params.get('intent') === 'reject');
      })
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : 'Could not load this approval'),
      )
      .finally(() => setLoading(false));
  }, []);

  const decide = async (action: 'approve' | 'reject') => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.publicPost<DecisionResponseDto>(
        `/public/approvals/${encodeURIComponent(token)}/decision`,
        { action, ...(note.trim() ? { note: note.trim() } : {}) },
      );
      setDecision(result);
      setPreview((current) => (current ? { ...current, state: 'used', action } : current));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex h-14 w-full max-w-xl items-center gap-2 px-4">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <IconBrand className="h-4 w-4" aria-hidden />
          </span>
          <span className="text-[13px] font-semibold tracking-tight">PostPilot</span>
          <span className="text-[12px] text-muted-foreground">· approval request</span>
        </div>
      </header>

      <div className="mx-auto w-full max-w-xl px-4 py-5">
        <h1 className="text-[19px] font-semibold tracking-tight">
          {decision
            ? decision.action === 'approve'
              ? 'Approved'
              : 'Rejected'
            : 'Review this post'}
        </h1>
        <p className="mt-0.5 text-[12.5px] text-muted-foreground">
          {decision
            ? 'You can close this page. The dashboard always shows the current state.'
            : 'Read it once, then approve or reject. Nothing is published without your tap.'}
        </p>

        {loading ? <Skeleton className="mt-4 h-64 w-full" /> : null}

        {!loading && error ? (
          <div className="mt-4">
            <Alert tone="error" title="Something is wrong with this link">
              {error}
            </Alert>
          </div>
        ) : null}

        {!loading && decision ? (
          <div className="mt-4 space-y-3">
            <Alert
              tone={decision.action === 'approve' ? 'success' : 'info'}
              title={decision.action === 'approve' ? 'Approval recorded' : 'Rejection recorded'}
            >
              {decision.publish?.message ??
                (decision.action === 'approve'
                  ? 'Publishing is queued.'
                  : 'Nothing was published.')}
            </Alert>
            <Card>
              <CardContent className="space-y-2">
                <div className="flex items-center justify-between text-[12px] text-muted-foreground">
                  <span>{decision.post.runDate}</span>
                  <span className="capitalize">{decision.post.status.replace('_', ' ')}</span>
                </div>
                {decision.post.publishedUrl ? (
                  <a
                    href={decision.post.publishedUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="break-all text-[12.5px] text-primary underline-offset-2 hover:underline"
                  >
                    {decision.post.publishedUrl}
                  </a>
                ) : null}
              </CardContent>
            </Card>
          </div>
        ) : null}

        {!loading && !decision && preview?.post ? (
          <div className="mt-4 space-y-3">
            <Card>
              <CardContent className="space-y-2.5">
                <div className="flex items-center justify-between text-[11.5px] text-muted-foreground">
                  <span>{preview.post.runDate}</span>
                  <span>
                    {preview.post.charCount} chars · {preview.post.hashtags.length} hashtags
                  </span>
                </div>
                <div className="whitespace-pre-wrap break-words rounded-lg border border-border bg-canvas p-3 text-[13.5px] leading-relaxed">
                  {preview.post.fullText}
                </div>
                {preview.expiresAt ? (
                  <p className="text-[11px] text-muted-foreground">
                    Link expires {new Date(preview.expiresAt).toLocaleString('en-GB')}
                  </p>
                ) : null}
              </CardContent>
            </Card>

            {preview.state === 'actionable' ? (
              <>
                {showReject ? (
                  <Card>
                    <CardContent className="space-y-2.5">
                      <p className="text-[13px] font-medium">Reject this post?</p>
                      <Textarea
                        rows={2}
                        value={note}
                        placeholder="Optional note (kept in the audit log)"
                        onChange={(event) => setNote(event.target.value)}
                      />
                      <div className="flex gap-2">
                        <Button
                          variant="ghost"
                          className="flex-1"
                          onClick={() => setShowReject(false)}
                        >
                          Cancel
                        </Button>
                        <Button
                          variant="outline"
                          className="flex-1"
                          loading={busy}
                          onClick={() => decide('reject')}
                        >
                          <IconClose className="h-4 w-4" aria-hidden /> Confirm reject
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ) : null}

                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="success"
                    size="lg"
                    loading={busy}
                    onClick={() => decide('approve')}
                  >
                    <IconApprove className="h-5 w-5" aria-hidden /> Approve
                  </Button>
                  <Button
                    variant="outline"
                    size="lg"
                    loading={busy}
                    onClick={() => setShowReject(true)}
                  >
                    <IconClose className="h-5 w-5" aria-hidden /> Reject
                  </Button>
                </div>

                <p className="flex items-start gap-1.5 px-1 text-[11px] leading-relaxed text-muted-foreground">
                  <IconSecurity className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  Single-use link, expires automatically. Approved text is published exactly as
                  shown
                  {intent === 'reject' ? ' — you opened the reject link from the email.' : '.'}
                </p>
              </>
            ) : (
              <Alert
                tone={preview.state === 'used' ? 'info' : 'warning'}
                title={`Link ${preview.state}`}
              >
                {preview.message}
              </Alert>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
