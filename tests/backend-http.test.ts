import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { POST as createRoom } from '../src/app/api/rooms/route';
import { GET as readRoom } from '../src/app/api/rooms/[code]/route';
import { POST as roomAction } from '../src/app/api/rooms/[code]/[action]/route';
import { POST as timeoutCheck } from '../src/app/api/internal/timeout-check/route';
import { POST as testFixture } from '../src/app/api/internal/test-room/route';
import { checkOrigin } from '../src/lib/server/http';
import { LocalRoomStore, getStore, replaceStoreForTests } from '../src/lib/server/store';
import { scheduleTimeout } from '../src/lib/server/scheduler';

describe('HTTP security and validation boundaries', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'xiangqi-http-'));
    replaceStoreForTests(new LocalRoomStore(join(directory, 'rooms.json')));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    replaceStoreForTests();
    await rm(directory, { recursive: true, force: true });
  });

  function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    return new Request(`http://localhost:3000${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  it('accepts same-origin browser requests through LAN hosts and reverse proxies and rejects other origins', () => {
    expect(() =>
      checkOrigin(
        new Request('http://localhost:3001/api/rooms', {
          headers: { host: '127.0.0.1:3001', origin: 'http://127.0.0.1:3001' },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      checkOrigin(
        new Request('http://localhost:3000/api/rooms', {
          headers: { host: '192.168.1.10:3000', origin: 'http://192.168.1.10:3000' },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      checkOrigin(
        new Request('http://internal/api/rooms', {
          headers: {
            host: 'play.example.com',
            'x-forwarded-proto': 'https',
            origin: 'https://play.example.com',
          },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      checkOrigin(
        new Request('http://localhost/api/rooms', {
          headers: { host: 'play.example.com', origin: 'https://attacker.example' },
        }),
      ),
    ).toThrow('This request did not come from the game.');
  });

  it('rejects cross-origin commands before creating any room', async () => {
    const response = await createRoom(
      post('/api/rooms', { name: 'Guest' }, { origin: 'https://elsewhere.example' }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'INVALID_ORIGIN' });
  });

  it('rejects malformed and oversized JSON without trusting content-length', async () => {
    const malformed = await createRoom(
      new Request('http://localhost/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{oops',
      }),
    );
    expect(malformed.status).toBe(400);
    const tooLarge = await createRoom(post('/api/rooms', { name: 'x'.repeat(9_000) }));
    expect(tooLarge.status).toBe(413);
    const missingContentType = await createRoom(
      new Request('http://localhost/api/rooms', { method: 'POST', body: '{}' }),
    );
    expect(missingContentType.status).toBe(400);
  });

  it('requires the original bearer seat token and rejects commands lacking a match identifier', async () => {
    const created = await (await createRoom(post('/api/rooms', { name: 'Guest' }))).json();
    const code = created.snapshot.code;
    const context = { params: Promise.resolve({ code }) };
    const unauthenticated = await readRoom(
      new Request(`http://localhost/api/rooms/${code}`),
      context,
    );
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toMatchObject({ code: 'INVALID_TOKEN' });
    const valid = await readRoom(
      new Request(`http://localhost/api/rooms/${code}`, {
        headers: { authorization: `Bearer ${created.token}` },
      }),
      context,
    );
    expect(valid.status).toBe(200);
    expect(valid.headers.get('cache-control')).toContain('no-store');
    const missingEpoch = await roomAction(
      post(
        `/api/rooms/${code}/ready`,
        { ready: true },
        { authorization: `Bearer ${created.token}` },
      ),
      { params: Promise.resolve({ code, action: 'ready' }) },
    );
    expect(missingEpoch.status).toBe(400);
  });

  it('protects scheduled timeout checks with a secret and makes missing-room delivery harmless', async () => {
    vi.stubEnv('TIMEOUT_SECRET', 'only-the-scheduler-knows');
    expect(
      (await timeoutCheck(post('/api/internal/timeout-check', { code: '23456789AB' }))).status,
    ).toBe(401);
    expect(
      (
        await timeoutCheck(
          post(
            '/api/internal/timeout-check',
            { code: '23456789AB' },
            { authorization: 'Bearer incorrect' },
          ),
        )
      ).status,
    ).toBe(401);
    const valid = await timeoutCheck(
      post(
        '/api/internal/timeout-check',
        { code: '23456789AB' },
        { authorization: 'Bearer only-the-scheduler-knows' },
      ),
    );
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ finalized: false });
  });

  it('never exposes test fixture routes on Vercel or without the local test secret', async () => {
    vi.stubEnv('E2E_TEST_MODE', '1');
    vi.stubEnv('E2E_TEST_SECRET', 'local-fixture-secret');
    vi.stubEnv('VERCEL', '1');
    const body = { code: '23456789AB', scenario: 'timeout' };
    expect(
      (
        await testFixture(
          post('/api/internal/test-room', body, { 'x-test-secret': 'local-fixture-secret' }),
        )
      ).status,
    ).toBe(404);
    vi.stubEnv('VERCEL', '');
    expect(
      (await testFixture(post('/api/internal/test-room', body, { 'x-test-secret': 'incorrect' })))
        .status,
    ).toBe(404);
    vi.stubEnv('E2E_TEST_MODE', '');
    expect(
      (
        await testFixture(
          post('/api/internal/test-room', body, { 'x-test-secret': 'local-fixture-secret' }),
        )
      ).status,
    ).toBe(404);
  });

  it('fails closed in production when Redis or the timed-game scheduler is missing', async () => {
    replaceStoreForTests();
    for (const variable of [
      'UPSTASH_REDIS_REST_URL',
      'UPSTASH_REDIS_REST_TOKEN',
      'KV_REST_API_URL',
      'KV_REST_API_TOKEN',
      'QSTASH_TOKEN',
      'TIMEOUT_SECRET',
      'APP_BASE_URL',
      'E2E_TEST_MODE',
      'VERCEL',
    ])
      vi.stubEnv(variable, '');
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => getStore()).toThrow('Online rooms need Redis configured.');
    await expect(
      scheduleTimeout({
        status: 'playing',
        settings: { clockMode: 'increment' },
        clocks: { turnStartedAt: 1, turnRemainingMs: 10_000 },
      } as Parameters<typeof scheduleTimeout>[0]),
    ).rejects.toMatchObject({ code: 'SCHEDULER_NOT_CONFIGURED' });
    vi.stubEnv('E2E_TEST_MODE', '1');
    vi.stubEnv('VERCEL', '1');
    expect(() => getStore()).toThrow('Online rooms need Redis configured.');
    await expect(
      scheduleTimeout({
        status: 'playing',
        settings: { clockMode: 'increment' },
        clocks: { turnStartedAt: 1, turnRemainingMs: 10_000 },
      } as Parameters<typeof scheduleTimeout>[0]),
    ).rejects.toMatchObject({ code: 'SCHEDULER_NOT_CONFIGURED' });
  });
});
