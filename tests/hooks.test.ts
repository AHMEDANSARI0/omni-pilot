import { describe, expect, it } from 'vitest';
import {
  PROMPT_HOOK_LIMIT,
  buildHookLibrary,
  hookGuidance,
  hookPattern,
  outcomeOf,
} from '@/src/core/hooks';

function post(hook: string, status: string, runDate: string) {
  return { hook, status, runDate };
}

describe('Phase 7 - hook library', () => {
  it('labels the shape of a hook', () => {
    expect(hookPattern('I deleted 400 lines of retry logic and the pipeline got faster.')).toBe(
      'number',
    );
    expect(hookPattern('The publish job failing silently cost me a week.')).toBe('failure story');
    expect(hookPattern('Retries or idempotency keys - pick one.')).toBe('trade-off');
    expect(hookPattern('How I cut cold start time in half.')).toBe('short how-to');
    expect(hookPattern('Why does every agent tool call need an id?')).toBe('question');
    expect(hookPattern('Approval emails went to spam.')).toBe('plain statement');
  });

  it('maps post statuses onto outcomes, without inventing a success', () => {
    expect(outcomeOf('published')).toBe('published');
    expect(outcomeOf('approved')).toBe('approved');
    expect(outcomeOf('rejected')).toBe('rejected');
    expect(outcomeOf('expired')).toBe('rejected');
    expect(outcomeOf('pending_approval')).toBe('pending');
    expect(outcomeOf('something_new')).toBe('pending');
  });

  it('counts a hook as proven only when its post published', () => {
    const library = buildHookLibrary([
      post('Approval emails went to spam for three days.', 'approved', '2026-11-16'),
      post('I deleted 400 lines of retry logic.', 'published', '2026-11-10'),
      post('My webhook retried the same decision twice.', 'rejected', '2026-11-05'),
    ]);
    expect(library.proven.map((record) => record.runDate)).toEqual(['2026-11-10']);
    expect(library.waiting.map((record) => record.runDate)).toEqual(['2026-11-16']);
    expect(library.rejected.map((record) => record.runDate)).toEqual(['2026-11-05']);
  });

  it('says so plainly when nothing has published yet', () => {
    const library = buildHookLibrary([post('Something pending.', 'pending_approval', '2026-11-16')]);
    expect(library.proven).toEqual([]);
    expect(library.summary).toContain('No published post yet');
  });

  it('summarises the dominant pattern from real data', () => {
    const library = buildHookLibrary([
      post('I broke the cron and nothing published for two days.', 'published', '2026-11-16'),
      post('The queue failed silently overnight.', 'published', '2026-11-15'),
      post('How I trace a failing publish job.', 'published', '2026-11-14'),
    ]);
    // "How I trace a failing publish job" is a failure story too: the failure pattern wins over
    // how-to because that is the shape the hook actually uses.
    expect(library.patterns[0]).toEqual({ pattern: 'failure story', count: 3 });
    expect(library.summary).toContain('3 proven hook(s)');
  });

  it('caps how many hooks reach the prompt', () => {
    const posts = Array.from({ length: 12 }, (_, index) =>
      post(`Failure number ${index} in the pipeline.`, 'published', `2026-11-${String(index + 1).padStart(2, '0')}`),
    );
    expect(buildHookLibrary(posts).proven).toHaveLength(PROMPT_HOOK_LIMIT);
  });

  it('orders by date, newest first', () => {
    const library = buildHookLibrary([
      post('Older failure story.', 'published', '2026-10-01'),
      post('Newer failure story.', 'published', '2026-11-01'),
    ]);
    expect(library.proven[0]!.runDate).toBe('2026-11-01');
  });

  it('ignores blank hooks instead of storing empty strings', () => {
    const library = buildHookLibrary([post('   ', 'published', '2026-11-01')]);
    expect(library.proven).toEqual([]);
  });

  it('writes no prompt block when the library is empty', () => {
    expect(hookGuidance(buildHookLibrary([]))).toBe('');
    expect(hookGuidance(buildHookLibrary([post('Pending one.', 'pending_approval', '2026-11-01')]))).toBe('');
  });

  it('tells the model the shape to reuse and the shape to avoid', () => {
    const library = buildHookLibrary([
      post('I deleted 400 lines of retry logic.', 'published', '2026-11-10'),
      post('My webhook retried the same decision twice.', 'rejected', '2026-11-05'),
    ]);
    const block = hookGuidance(library);
    expect(block).toContain('OPENINGS THAT WORKED');
    expect(block).toContain('I deleted 400 lines of retry logic.');
    expect(block).toContain('OPENINGS THE OWNER REJECTED');
    expect(block).toContain('do not repeat this shape');
  });

  it('never claims a pattern when there is no proven post', () => {
    const library = buildHookLibrary([post('Rejected one about a bug.', 'rejected', '2026-11-05')]);
    const block = hookGuidance(library);
    expect(block).not.toContain('OPENINGS THAT WORKED');
    expect(block).toContain('OPENINGS THE OWNER REJECTED');
  });
});
