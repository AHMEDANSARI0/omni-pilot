import { describe, expect, it } from 'vitest';
import { PostgrestClient, PostgrestDatabase } from '@/src/adapters/db/postgrest';

/**
 * The production database path has to write the slot.
 *
 * Phase 10 added `slot_index`, the route passed it down, and the PostgREST adapter dropped it on the floor:
 * `createTopic` never named the column, so PostgreSQL filled in its `default 0`. Every request answered 201
 * with `slotIndex: 0` - the topic was created, so nothing looked broken, and only the second slot of a day
 * noticed. `npm run e2e` reported `Expected: 1, Received: 0` on the topic it had just created.
 *
 * The memory adapter is not enough to catch this: it stores whatever object it is handed, so a dropped column
 * cannot happen there. These assertions read the request body the way the database would.
 *
 * Found 2026-11-18 in the owner's own `npm run e2e` output, after three fixes that all looked right.
 */
function database() {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const sent = init?.body ? JSON.parse(String(init.body)) : {};
    return new Response(JSON.stringify([{ ...sent, id: 'row-1', status: 'pending', attempts: 0 }]), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const client = new PostgrestClient({
    url: 'https://project.supabase.co',
    serviceRoleKey: 'service-role-key',
    fetchImpl,
  });
  return { db: new PostgrestDatabase(client), calls };
}

describe('PostgREST adapter writes the slot', () => {
  it('sends slot_index when a topic is created for the second slot', async () => {
    const { db, calls } = database();
    await db.createTopic({
      sheetRowNumber: null,
      topicDate: '2034-02-01',
      slotIndex: 1,
      topic: 'second slot',
      contentType: 'insight',
      keyPoints: null,
      targetAudience: null,
    });
    const insert = calls.find((call) => call.url.includes('content_topics') && call.method === 'POST');
    expect(insert, 'a POST to content_topics').toBeTruthy();
    expect((insert!.body as Record<string, unknown>).slot_index).toBe(1);
  });

  it('sends slot_index 0 for a topic that has no slot, rather than leaving it to the column default', async () => {
    const { db, calls } = database();
    await db.createTopic({
      sheetRowNumber: null,
      topicDate: '2034-02-01',
      topic: 'first slot',
      contentType: 'insight',
      keyPoints: null,
      targetAudience: null,
    });
    const insert = calls.find((call) => call.url.includes('content_topics') && call.method === 'POST');
    expect((insert!.body as Record<string, unknown>).slot_index).toBe(0);
  });

  it('reads slot_index back from the row it wrote', async () => {
    const { db } = database();
    const topic = await db.createTopic({
      sheetRowNumber: null,
      topicDate: '2034-02-01',
      slotIndex: 2,
      topic: 'third slot',
      contentType: 'insight',
      keyPoints: null,
      targetAudience: null,
    });
    expect(topic.slotIndex).toBe(2);
  });
});

describe('PostgREST adapter writes the slot when a whole sheet is synced', () => {
  it('sends slot_index per topic in the upsert payload', async () => {
    const { db, calls } = database();
    await db.upsertTopics([
      {
        sheetRowNumber: 1,
        topicDate: '2034-03-01',
        slotIndex: 2,
        topic: 'sheet row with a slot',
        contentType: 'insight',
        keyPoints: null,
        targetAudience: null,
      },
    ]);
    const upsert = calls.find((call) => call.url.includes('content_topics') && call.method === 'POST');
    const payload = upsert!.body as Array<Record<string, unknown>>;
    expect(payload[0]!.slot_index).toBe(2);
  });

  it('sends slot_index 0 for a sheet row that has no slot', async () => {
    const { db, calls } = database();
    await db.upsertTopics([
      {
        sheetRowNumber: 2,
        topicDate: '2034-03-02',
        topic: 'single-slot sheet row',
        contentType: 'insight',
        keyPoints: null,
        targetAudience: null,
      },
    ]);
    const upsert = calls.find((call) => call.url.includes('content_topics') && call.method === 'POST');
    const payload = upsert!.body as Array<Record<string, unknown>>;
    expect(payload[0]!.slot_index).toBe(0);
  });
});

describe('a slot that does not survive the write is an error, not a success', () => {
  it('refuses to answer 201 when the database returns a different slot', async () => {
    // The database answering `slot_index: 0` for a slot-1 insert is exactly what a dropped column looks like.
    const calls: unknown[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(input);
      return new Response(JSON.stringify([{ id: 'row-1', slot_index: 0, status: 'pending', attempts: 0 }]), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const db = new PostgrestDatabase(
      new PostgrestClient({ url: 'https://project.supabase.co', serviceRoleKey: 'k', fetchImpl }),
    );
    await expect(
      db.createTopic({
        sheetRowNumber: null,
        topicDate: '2034-02-01',
        slotIndex: 1,
        topic: 'second slot',
        contentType: 'insight',
        keyPoints: null,
        targetAudience: null,
      }),
    ).rejects.toThrow(/slot 0 .*slot 1|slot_index was not written/);
  });
});
