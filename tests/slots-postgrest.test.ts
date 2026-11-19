/**
 * Phase 10 - the per-slot claim path, exercised straight against the PostgREST adapter.
 *
 * Why a separate file. Phase 10 changes `claimDailyTopic` (it now sends `p_slot`) and adds
 * `claimGenerationSlot` / `finishGenerationSlot`. Those assertions live in `tests/postgrest.test.ts`,
 * which a patcher must not touch when the owner has edited that file - so the coverage they provide can
 * silently disappear. This file owns the same territory and depends on nothing the owner may have
 * changed: one fetch double, the adapter, and the wire format.
 */
import { describe, expect, it } from 'vitest';
import { PostgrestClient, PostgrestDatabase } from '@/src/adapters/db/postgrest';
import { AppError } from '@/src/core/errors';

interface Call {
  url: string;
  method: string;
  body: any;
}

/** A PostgREST stand-in that records every request and answers per route. */
function makeDb(respond: (call: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    calls.push(call);
    const { status, body } = respond(call);
    return new Response(body === null ? '' : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  const db = new PostgrestDatabase(
    new PostgrestClient({
      url: 'https://example.supabase.co',
      serviceRoleKey: 'service-key',
      fetchImpl,
    }),
  );
  return { db, calls };
}

describe('Phase 10 - slot claims reach PostgREST with the slot in the body', () => {
  it('claimDailyTopic sends slot 0 when no slot is given (single-slot behaviour unchanged)', async () => {
    const { db, calls } = makeDb(() => ({ status: 200, body: [] }));
    await expect(db.claimDailyTopic('2026-11-16', 3)).resolves.toBeNull();
    expect(calls[0]?.url).toContain('/rpc/claim_daily_topic');
    expect(calls[0]?.body).toEqual({ p_date: '2026-11-16', p_max_attempts: 3, p_slot: 0 });
  });

  it('claimDailyTopic carries a later slot through unchanged', async () => {
    const { db, calls } = makeDb(() => ({ status: 200, body: [] }));
    await db.claimDailyTopic('2026-11-16', 3, 2);
    expect(calls[0]?.body).toEqual({ p_date: '2026-11-16', p_max_attempts: 3, p_slot: 2 });
  });

  it('claimGenerationSlot claims exactly one (date, slot) pair', async () => {
    const { db, calls } = makeDb(() => ({ status: 200, body: true }));
    await expect(db.claimGenerationSlot('2026-11-16', 1, 3)).resolves.toBe(true);
    expect(calls[0]?.url).toContain('/rpc/claim_generation_slot');
    expect(calls[0]?.body).toEqual({ p_date: '2026-11-16', p_slot: 1, p_max_attempts: 3 });
  });

  it('claimGenerationSlot reports a lost race as false, not as success', async () => {
    const { db } = makeDb(() => ({ status: 200, body: false }));
    await expect(db.claimGenerationSlot('2026-11-16', 0, 3)).resolves.toBe(false);
  });

  it('finishGenerationSlot records the outcome for that slot only', async () => {
    const { db, calls } = makeDb(() => ({ status: 200, body: null }));
    await db.finishGenerationSlot('2026-11-16', 3, 'succeeded');
    expect(calls[0]?.url).toContain('/rpc/finish_generation_slot');
    expect(calls[0]?.body).toEqual({
      p_date: '2026-11-16',
      p_slot: 3,
      p_status: 'succeeded',
    });
  });

  it('a failing RPC surfaces as a DATABASE_ERROR instead of a silent false', async () => {
    const { db } = makeDb(() => ({ status: 500, body: { message: 'boom' } }));
    await expect(db.claimGenerationSlot('2026-11-16', 0, 3)).rejects.toBeInstanceOf(AppError);
  });

  it('a missing stored procedure is reported, not swallowed', async () => {
    // The migration ships in this phase; an owner who has not run it must find out from the error.
    const { db } = makeDb(() => ({ status: 404, body: { message: 'function does not exist' } }));
    const error = await db.claimGenerationSlot('2026-11-16', 4, 3).catch((caught) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('DATABASE_ERROR');
  });
});
