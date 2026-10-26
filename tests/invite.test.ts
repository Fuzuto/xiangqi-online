import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomService } from '../src/lib/server/service';
import { readInvite } from '../src/lib/server/invite';
import type { RoomRecord } from '../src/lib/server/model';
import type { RoomStore } from '../src/lib/server/store';
import { replaceStoreForTests } from '../src/lib/server/store';
import { GET as inviteRoute } from '../src/app/api/rooms/[code]/invite/route';

class InviteStore implements RoomStore {
  kind = 'local' as const;
  records = new Map<string, RoomRecord>();
  rateLimit = vi.fn<RoomStore['rateLimit']>().mockResolvedValue(true);
  compareAndSet = vi.fn<RoomStore['compareAndSet']>(async (code, version, room) => {
    const current = this.records.get(code);
    if (version === null ? Boolean(current) : current?.version !== version) return false;
    this.records.set(code, structuredClone(room));
    return true;
  });
  async get(code: string) {
    return structuredClone(this.records.get(code) ?? null);
  }
  async updates() {
    return null;
  }
}

describe('public invitation preview', () => {
  let store: InviteStore;
  let rooms: RoomService;
  let code: string;
  let token: string;
  const now = 1_000_000;

  beforeEach(async () => {
    store = new InviteStore();
    rooms = new RoomService(store, { now: () => now });
    const created = await rooms.create({ name: 'River' }, 'host');
    code = created.snapshot.code;
    token = created.token!;
    store.rateLimit.mockClear();
    store.compareAndSet.mockClear();
  });

  it('returns only the host and match context without exposing seat credentials or changing presence', async () => {
    const before = structuredClone(store.records.get(code));
    const response = await readInvite(store, code.toLowerCase(), 'visitor', now + 1_000);
    expect(response).toEqual({
      invite: {
        code,
        opponent: { displayName: 'River', color: 'red' },
        settings: before!.settings,
        status: 'waiting',
        canJoin: true,
      },
    });
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain(token);
    for (const privateField of [
      'tokenHash',
      'hostId',
      'gameId',
      'branchId',
      'board',
      'lastSeenAt',
      'seats',
    ]) {
      expect(serialized).not.toContain(privateField);
    }
    expect(store.records.get(code)).toEqual(before);
    expect(store.compareAndSet).not.toHaveBeenCalled();
    expect(store.rateLimit).toHaveBeenCalledWith(
      expect.stringMatching(/^ip:[a-f0-9]{24}:invite$/),
      60,
      60_000,
      now + 1_000,
    );
    expect(store.rateLimit).toHaveBeenCalledWith(`room:${code}:invite`, 120, 60_000, now + 1_000);
    expect(JSON.stringify(store.rateLimit.mock.calls)).not.toContain('visitor');
  });

  it('finds the host after color assignment instead of assuming the red seat', async () => {
    const record = store.records.get(code)!;
    record.seats.black = record.seats.red;
    record.seats.red = null;
    record.settings.hostSide = 'black';
    const response = await readInvite(store, code, 'visitor', now);
    expect(response.invite.opponent).toEqual({ displayName: 'River', color: 'black' });
    expect(response.invite.canJoin).toBe(true);
  });

  it('keeps full and started rooms unavailable without leaking their boards', async () => {
    await rooms.join(code, { name: 'Mountain' }, undefined, 'guest');
    expect((await readInvite(store, code, 'visitor', now)).invite.canJoin).toBe(false);
    const record = store.records.get(code)!;
    record.status = 'playing';
    record.seats.black = null;
    expect((await readInvite(store, code, 'visitor', now)).invite).toMatchObject({
      status: 'playing',
      canJoin: false,
    });
  });

  it('distinguishes expired and missing invitations and validates the room code', async () => {
    await expect(readInvite(store, 'not/a/code', 'visitor', now)).rejects.toMatchObject({
      code: 'ROOM_NOT_FOUND',
      status: 404,
    });
    await expect(readInvite(store, '23456789AB', 'visitor', now)).rejects.toMatchObject({
      code: 'ROOM_NOT_FOUND',
      status: 404,
    });
    store.records.get(code)!.expiresAt = now;
    await expect(readInvite(store, code, 'visitor', now)).rejects.toMatchObject({
      code: 'ROOM_EXPIRED',
      status: 410,
    });
  });

  it('limits both visitor IP and the invited room before reading room details', async () => {
    const get = vi.spyOn(store, 'get');
    store.rateLimit.mockResolvedValueOnce(false);
    await expect(readInvite(store, code, 'visitor', now)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
    });
    expect(get).not.toHaveBeenCalled();
    store.rateLimit.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(readInvite(store, code, 'visitor', now)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
    });
    expect(get).not.toHaveBeenCalled();
  });

  it('serves the invite envelope without authorization and prevents caching', async () => {
    store.records.get(code)!.expiresAt = Date.now() + 60_000;
    replaceStoreForTests(store);
    try {
      const response = await inviteRoute(new Request(`http://localhost/api/rooms/${code}/invite`), {
        params: Promise.resolve({ code }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store, private');
      expect(await response.json()).toMatchObject({
        invite: { code, opponent: { displayName: 'River' }, canJoin: true },
      });
    } finally {
      replaceStoreForTests();
    }
  });
});
