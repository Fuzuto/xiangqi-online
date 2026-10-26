import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { RoomService } from '../src/lib/server/service';
import { LocalRoomStore, RedisRoomStore } from '../src/lib/server/store';
import type { RoomStore } from '../src/lib/server/store';
import type { RoomRecord } from '../src/lib/server/model';
import type { RoomAction } from '../src/lib/server/types';
import { scheduleTimeout } from '../src/lib/server/scheduler';

class MemoryStore implements RoomStore {
  kind = 'local' as const;
  records = new Map<string, RoomRecord>();
  rates = new Map<string, { count: number; expires: number }>();
  async get(code: string) {
    return structuredClone(this.records.get(code) ?? null);
  }
  async compareAndSet(code: string, version: number | null, next: RoomRecord) {
    const current = this.records.get(code);
    if (version === null ? Boolean(current) : current?.version !== version) return false;
    this.records.set(code, structuredClone(next));
    return true;
  }
  async rateLimit(key: string, limit: number, windowMs: number, now: number) {
    const previous = this.rates.get(key);
    const rate =
      previous && previous.expires > now ? previous : { count: 0, expires: now + windowMs };
    this.rates.set(key, rate);
    return ++rate.count <= limit;
  }
  async updates() {
    return null;
  }
}

async function command(
  rooms: RoomService,
  code: string,
  kind: RoomAction,
  body: unknown,
  token: string,
  ip: string,
) {
  const current = (await rooms.store.get(code))!;
  const caller = Object.values(current.seats).find(
    (seat) => seat?.tokenHash === createHash('sha256').update(token).digest('hex'),
  );
  const data = body as Record<string, unknown>;
  const offerId =
    (kind === 'draw' || kind === 'undo') && data.action !== 'offer'
      ? current.pendingOffers[kind]?.id
      : undefined;
  return rooms.action(
    code,
    kind,
    {
      ...data,
      gameId: current.gameId,
      ...(kind === 'move' ? { branchId: current.branchId } : {}),
      ...(kind === 'leave' ? { presenceId: caller?.presenceId ?? caller?.id } : {}),
      ...(offerId ? { offerId } : {}),
    },
    token,
    ip,
  );
}

describe('authoritative rooms and clocks', () => {
  let store: MemoryStore;
  let rooms: RoomService;
  let now: number;
  let red: string;
  let black: string;
  let code: string;
  let schedule: ReturnType<typeof vi.fn<(room: RoomRecord) => Promise<void>>>;

  beforeEach(async () => {
    vi.stubEnv('E2E_TEST_MODE', '1');
    now = 1_000_000;
    store = new MemoryStore();
    schedule = vi.fn<(room: RoomRecord) => Promise<void>>().mockResolvedValue(undefined);
    rooms = new RoomService(store, { now: () => now, schedule });
    const created = await rooms.create({ name: '  Red  ' }, 'host');
    code = created.snapshot.code;
    red = created.token!;
    black = (await rooms.join(code, { name: 'Black' }, undefined, 'guest')).token!;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const action = (kind: RoomAction, body: unknown, token: string) =>
    command(rooms, code, kind, body, token, token === red ? 'host' : 'guest');
  async function start(settings: unknown = {}) {
    await action('settings', settings, red);
    await action('ready', { ready: true }, red);
    return (await action('ready', { ready: true }, black)).snapshot;
  }
  const move = (token: string, seq: number, from: number, to: number, key = `request_${seq}`) =>
    action('move', { seq, from, to, idempotencyKey: key }, token);

  it('issues a private room and hashes tokens without exposing them in snapshots', async () => {
    const snapshot = (await rooms.read(code, red, 'host')).snapshot;
    expect(code).toMatch(/^[2-9A-HJ-NP-Z]{10}$/);
    expect(snapshot.seats.red?.displayName).toBe('Red');
    expect(JSON.stringify(snapshot)).not.toContain(red);
    expect(JSON.stringify(snapshot)).not.toContain('tokenHash');
    expect(JSON.stringify(store.records.get(code))).not.toContain(red);
    expect(store.records.get(code)!.seats.red!.tokenHash).toHaveLength(64);
    await expect(rooms.read(code, 'wrong-token', 'stranger')).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    });
    await expect(rooms.join(code, { name: 'Third' }, undefined, 'third')).rejects.toMatchObject({
      code: 'ROOM_FULL',
    });
  });

  it('sanitizes names and preserves a seat, pending offer, board, and clock on token restoration', async () => {
    const restored = await rooms.join(code, {}, red, 'host');
    expect(restored.snapshot.you.color).toBe('red');
    await start();
    now += 2_000;
    await move(red, 0, 54, 45);
    await action('draw', { action: 'offer' }, red);
    const refresh = (await rooms.join(code, {}, red, 'host')).snapshot;
    expect(refresh.game.moves).toHaveLength(1);
    expect(refresh.pendingOffers.draw?.by).toBe('red');
    expect(refresh.clocks.remaining.red).toBe(598_000);
    const sanitized = await rooms.create(
      { name: ' <script>\u0000   Very long guest name here  ' },
      'other',
    );
    expect(sanitized.snapshot.seats.red?.displayName).toBe('script Very long gue');
  });

  it('requires two ready players, resets readiness on settings changes, locks settings during play', async () => {
    await action('ready', { ready: true }, red);
    expect((await rooms.read(code, red, 'host')).snapshot.status).toBe('waiting');
    await action('settings', { allowUndo: true }, red);
    expect((await rooms.read(code, red, 'host')).snapshot.seats.red?.ready).toBe(false);
    await action('ready', { ready: true }, red);
    await action('ready', { ready: false }, black);
    expect((await rooms.read(code, red, 'host')).snapshot.seats.red?.ready).toBe(false);
    const started = await start();
    expect(started.status).toBe('playing');
    expect(started.clocks.turnStartedAt).toBe(now);
    await expect(action('settings', { allowUndo: false }, red)).rejects.toMatchObject({
      code: 'SETTINGS_LOCKED',
    });
  });

  it('lets the host select black and maintains identity across side reassignment', async () => {
    const changed = (await action('settings', { hostSide: 'black' }, red)).snapshot;
    expect(changed.you.color).toBe('black');
    expect(changed.seats.black?.displayName).toBe('Red');
    expect((await rooms.read(code, black, 'guest')).snapshot.you.color).toBe('red');
    await expect(action('settings', { allowUndo: true }, black)).rejects.toMatchObject({
      code: 'HOST_ONLY',
    });
  });

  it('skips increment for each player’s first move, then credits completed later moves', async () => {
    await start({ mainTimeMs: 10_000, incrementMs: 500 });
    now += 1_000;
    expect((await move(red, 0, 54, 45)).snapshot.clocks.remaining.red).toBe(9_000);
    now += 2_000;
    expect((await move(black, 1, 27, 36)).snapshot.clocks.remaining.black).toBe(8_000);
    now += 3_000;
    expect((await move(red, 2, 45, 36)).snapshot.clocks.remaining.red).toBe(6_500);
    expect(schedule).toHaveBeenCalledTimes(4);
  });

  it('resets the next player’s per-move allowance and keeps untimed clocks stopped', async () => {
    await start({ clockMode: 'per-move', perMoveMs: 3_000 });
    now += 1_000;
    const first = (await move(red, 0, 54, 45)).snapshot;
    expect(first.clocks.remaining.red).toBe(2_000);
    expect(first.clocks.turnRemainingMs).toBe(3_000);
    now += 500;
    const second = (await move(black, 1, 27, 36)).snapshot;
    expect(second.clocks.remaining.red).toBe(3_000);
    expect(second.clocks.remaining.black).toBe(2_500);
    const fresh = await rooms.create({ name: 'Untimed' }, 'fresh');
    const partner = await rooms.join(
      fresh.snapshot.code,
      { name: 'Partner' },
      undefined,
      'partner',
    );
    await command(
      rooms,
      fresh.snapshot.code,
      'settings',
      { clockMode: 'untimed' },
      fresh.token!,
      'fresh',
    );
    await command(rooms, fresh.snapshot.code, 'ready', { ready: true }, fresh.token!, 'fresh');
    const ready = await command(
      rooms,
      fresh.snapshot.code,
      'ready',
      { ready: true },
      partner.token!,
      'partner',
    );
    expect(ready.snapshot.clocks.turnStartedAt).toBeNull();
  });

  it('finalizes an expired clock on read, rejects late moves by returning the result, and is idempotent', async () => {
    await start({ mainTimeMs: 10_000 });
    now += 10_000;
    const expired = (await move(red, 0, 54, 45)).snapshot;
    expect(expired.status).toBe('finished');
    expect(expired.result).toEqual({ winner: 'black', reason: 'timeout' });
    expect(expired.game.moves).toHaveLength(0);
    expect(expired.clocks.remaining.red).toBe(0);
    expect(await rooms.checkTimeout(code)).toEqual({ finalized: false });
    expect((await rooms.read(code, red, 'host')).snapshot.version).toBe(expired.version);
  });

  it('runs clocks during a disconnect and automatically forfeits an absent player after 30 seconds', async () => {
    await start({ mainTimeMs: 10_000 });
    now += 10_001;
    expect(await rooms.checkTimeout(code)).toEqual({ finalized: true });
    expect(store.records.get(code)!.result).toEqual({ winner: 'black', reason: 'timeout' });
    const fresh = await rooms.create({ name: 'Remaining' }, 'fresh');
    const partner = await rooms.join(fresh.snapshot.code, { name: 'Gone' }, undefined, 'partner');
    await command(
      rooms,
      fresh.snapshot.code,
      'settings',
      { clockMode: 'untimed' },
      fresh.token!,
      'fresh',
    );
    await command(rooms, fresh.snapshot.code, 'ready', { ready: true }, fresh.token!, 'fresh');
    await command(rooms, fresh.snapshot.code, 'ready', { ready: true }, partner.token!, 'partner');
    for (let beat = 0; beat < 2; beat++) {
      now += 10_000;
      expect(
        (await rooms.read(fresh.snapshot.code, fresh.token!, 'fresh')).snapshot.result,
      ).toBeNull();
    }
    now += 9_999;
    expect(
      (await rooms.read(fresh.snapshot.code, fresh.token!, 'fresh')).snapshot.result,
    ).toBeNull();
    now += 1;
    expect((await rooms.read(fresh.snapshot.code, fresh.token!, 'fresh')).snapshot.result).toEqual({
      winner: 'red',
      reason: 'disconnect',
    });
  });

  it('allows a disconnected player to restore their seat before the 30-second deadline', async () => {
    await start({ clockMode: 'untimed' });
    const started = now;
    now += 15_000;
    const away = (await rooms.read(code, red, 'host')).snapshot;
    expect(away.seats.black).toMatchObject({
      connected: false,
      disconnectDeadline: started + 30_000,
    });
    now += 10_000;
    const restored = (await rooms.join(code, {}, black, 'guest')).snapshot;
    expect(restored.result).toBeNull();
    expect(restored.seats.black).toMatchObject({ connected: true, disconnectDeadline: null });
    now += 10_000;
    expect((await rooms.read(code, red, 'host')).snapshot.result).toBeNull();
  });

  it('marks an explicit departure immediately and only token restoration cancels it', async () => {
    await start({ clockMode: 'untimed' });
    now += 1_000;
    const left = (await action('leave', {}, black)).snapshot;
    expect(left.seats.black).toMatchObject({ connected: false, disconnectDeadline: now + 30_000 });
    now += 2_000;
    const latePoll = (await rooms.read(code, black, 'guest')).snapshot;
    expect(latePoll.seats.black?.connected).toBe(false);
    expect(latePoll.seats.black?.disconnectDeadline).toBe(left.seats.black?.disconnectDeadline);
    const restored = (await rooms.join(code, {}, black, 'guest')).snapshot;
    expect(restored.seats.black).toMatchObject({ connected: true, disconnectDeadline: null });
  });

  it('ignores a delayed departure from before the seat was restored', async () => {
    const original = await start({ clockMode: 'untimed' });
    const oldPresenceId = original.you.presenceId;
    const restored = (await rooms.join(code, {}, black, 'guest')).snapshot;
    expect(restored.you.presenceId).not.toBe(oldPresenceId);
    const delayed = await rooms.action(
      code,
      'leave',
      {
        gameId: original.gameId,
        presenceId: oldPresenceId,
      },
      black,
      'guest',
    );
    expect(delayed.snapshot.seats.black?.connected).toBe(true);
    expect(store.records.get(code)!.seats.black?.leftAt).toBeNull();
    const currentLeave = await rooms.action(
      code,
      'leave',
      {
        gameId: original.gameId,
        presenceId: restored.you.presenceId,
      },
      black,
      'guest',
    );
    expect(currentLeave.snapshot.seats.black?.connected).toBe(false);
    await expect(
      rooms.action(code, 'leave', { gameId: original.gameId }, black, 'guest'),
    ).rejects.toThrow();
  });

  it('uses a stable presence identifier for legacy seats until their next restoration', async () => {
    await start({ clockMode: 'untimed' });
    const seat = store.records.get(code)!.seats.black!;
    delete seat.presenceId;
    const legacy = (await rooms.read(code, black, 'guest')).snapshot;
    expect(legacy.you.presenceId).toBe(seat.id);
    const laterRead = (await rooms.read(code, black, 'guest')).snapshot;
    expect(laterRead.you.presenceId).toBe(legacy.you.presenceId);
    const departed = (
      await rooms.action(
        code,
        'leave',
        {
          gameId: legacy.gameId,
          presenceId: legacy.you.presenceId,
        },
        black,
        'guest',
      )
    ).snapshot;
    expect(departed.seats.black?.connected).toBe(false);
    const restored = (await rooms.join(code, {}, black, 'guest')).snapshot;
    expect(restored.you.presenceId).not.toBe(legacy.you.presenceId);
    expect(restored.seats.black?.connected).toBe(true);
  });

  it('does not let a player restore their seat after they already lost by disconnect', async () => {
    await start({ clockMode: 'untimed' });
    for (let beat = 0; beat < 2; beat++) {
      now += 10_000;
      await rooms.read(code, red, 'host');
    }
    now += 10_000;
    const lateReturn = (await rooms.join(code, {}, black, 'guest')).snapshot;
    expect(lateReturn.result).toEqual({ winner: 'red', reason: 'disconnect' });
    expect(lateReturn.status).toBe('finished');
    expect((await rooms.read(code, red, 'host')).snapshot.result).toEqual(lateReturn.result);
  });

  it('does not award a disconnect win when both are away and grants fresh grace on return', async () => {
    await start({ clockMode: 'untimed' });
    now += 31_000;
    expect(await rooms.checkTimeout(code)).toEqual({ finalized: false });
    expect(store.records.get(code)!.result).toBeNull();
    const returned = (await rooms.join(code, {}, red, 'host')).snapshot;
    expect(returned.result).toBeNull();
    expect(returned.seats.black?.disconnectDeadline).toBe(now + 30_000);
    for (let beat = 0; beat < 2; beat++) {
      now += 10_000;
      expect((await rooms.read(code, red, 'host')).snapshot.result).toBeNull();
    }
    now += 10_000;
    expect((await rooms.read(code, red, 'host')).snapshot.result).toEqual({
      winner: 'red',
      reason: 'disconnect',
    });
  });

  it('adjudicates an untimed disconnect through the scheduled callback exactly once', async () => {
    await start({ clockMode: 'untimed' });
    for (let beat = 0; beat < 2; beat++) {
      now += 10_000;
      await rooms.read(code, red, 'host');
    }
    now += 10_000;
    expect(await rooms.checkTimeout(code)).toEqual({ finalized: true });
    const settled = structuredClone(store.records.get(code));
    expect(settled?.result).toEqual({ winner: 'red', reason: 'disconnect' });
    expect(await rooms.checkTimeout(code)).toEqual({ finalized: false });
    expect(store.records.get(code)).toEqual(settled);
  });

  it('uses the earlier disconnect deadline instead of a later clock timeout', async () => {
    await start({ mainTimeMs: 40_000 });
    await move(red, 0, 54, 45);
    for (let beat = 0; beat < 3; beat++) {
      now += 10_000;
      await rooms.read(code, red, 'host');
    }
    expect(store.records.get(code)!.result).toEqual({ winner: 'red', reason: 'disconnect' });
  });

  it('keeps waiting-room departures out of result adjudication and blocks start without both players', async () => {
    await action('leave', {}, black);
    now += 31_000;
    const waiting = (await rooms.read(code, red, 'host')).snapshot;
    expect(waiting.status).toBe('waiting');
    expect(waiting.result).toBeNull();
    expect(await rooms.checkTimeout(code)).toEqual({ finalized: false });
    await action('ready', { ready: true }, red);
    await expect(action('ready', { ready: true }, black)).rejects.toMatchObject({
      code: 'PLAYER_DISCONNECTED',
    });
  });

  it('rolls scheduled presence checks forward without scheduling on every heartbeat', async () => {
    await start({ clockMode: 'untimed' });
    expect(schedule).toHaveBeenCalledTimes(1);
    for (let beat = 0; beat < 2; beat++) {
      now += 10_000;
      await rooms.read(code, red, 'host');
      await rooms.read(code, black, 'guest');
    }
    expect(schedule).toHaveBeenCalledTimes(1);
    now += 10_000;
    await rooms.checkTimeout(code);
    expect(schedule).toHaveBeenCalledTimes(2);
    expect(store.records.get(code)!.presenceCheckAt).toBe(now + 20_000);
    await rooms.checkTimeout(code);
    expect(schedule).toHaveBeenCalledTimes(2);
  });

  it('makes double taps and simultaneous stale commands harmless', async () => {
    await start();
    const results = await Promise.all([
      move(red, 0, 54, 45, 'doubletap_one'),
      move(red, 0, 56, 47, 'doubletap_two'),
    ]);
    expect(results.every((item) => item.snapshot.game.moves.length === 1)).toBe(true);
    const stored = store.records.get(code)!;
    const original = stored.game.moves[0];
    expect(
      (await move(red, 0, original.from, original.to, 'doubletap_one')).snapshot.game.moves,
    ).toHaveLength(1);
    expect((await move(black, 0, 27, 36, 'stale_key')).snapshot.game.moves).toHaveLength(1);
    await expect(move(red, 1, 56, 47, 'wrongturn_key')).rejects.toMatchObject({
      code: 'NOT_YOUR_TURN',
    });
  });

  it('restores clocks, first-move flags, and repetition history on an approved undo', async () => {
    await start({ allowUndo: true, mainTimeMs: 10_000, incrementMs: 500 });
    now += 1_000;
    await move(red, 0, 54, 45);
    await action('undo', { action: 'offer' }, red);
    now += 500;
    const undone = (await action('undo', { action: 'accept' }, black)).snapshot;
    expect(undone.game.moves).toHaveLength(0);
    expect(undone.game.history).toHaveLength(1);
    expect(undone.clocks.remaining.red).toBe(9_000);
    expect(undone.clocks.remaining.black).toBe(10_000);
    expect(undone.clocks.turnStartedAt).toBe(now);
    now += 1_000;
    expect((await move(red, 0, 54, 45, 'after_undo')).snapshot.clocks.remaining.red).toBe(8_000);
  });

  it('requires opponent draw agreement and enforces draw offer cooldown', async () => {
    await start();
    await action('draw', { action: 'offer' }, red);
    await expect(action('draw', { action: 'accept' }, red)).rejects.toMatchObject({
      code: 'NO_OFFER',
    });
    await action('draw', { action: 'decline' }, black);
    await expect(action('draw', { action: 'offer' }, red)).rejects.toMatchObject({
      code: 'DRAW_COOLDOWN',
    });
    await action('draw', { action: 'offer' }, black);
    expect((await action('draw', { action: 'accept' }, red)).snapshot.result).toEqual({
      winner: null,
      reason: 'agreement',
    });
  });

  it('swaps colors on a mutually accepted rematch and resets readiness and clocks', async () => {
    await start();
    await action('resign', {}, red);
    await action('rematch', { action: 'request' }, red);
    const rematch = (await action('rematch', { action: 'accept' }, black)).snapshot;
    expect(rematch.status).toBe('waiting');
    expect(rematch.result).toBeNull();
    expect(rematch.you.color).toBe('red');
    expect(rematch.seats.black?.displayName).toBe('Red');
    expect(rematch.seats.red?.ready).toBe(false);
    expect(rematch.seats.black?.ready).toBe(false);
    expect(rematch.game.moves).toHaveLength(0);
    expect(rematch.clocks.turnStartedAt).toBeNull();
    expect(rematch.clocks.remaining.red).toBe(600_000);
  });

  it('permits a short no-result abort before the first move and forbids it afterward', async () => {
    await start();
    expect((await action('abort', {}, red)).snapshot.status).toBe('aborted');
    await action('rematch', { action: 'request' }, red);
    await action('rematch', { action: 'accept' }, black);
    await action('ready', { ready: true }, red);
    await action('ready', { ready: true }, black);
    await move(black, 0, 54, 45);
    await expect(action('abort', {}, red)).rejects.toMatchObject({ code: 'ABORT_UNAVAILABLE' });
  });

  it('distinguishes expired and absent rooms and limits repeated room creation', async () => {
    const expired = store.records.get(code)!;
    expired.expiresAt = now;
    await expect(rooms.read(code, red, 'host')).rejects.toMatchObject({ code: 'ROOM_EXPIRED' });
    await expect(rooms.read('23456789AB', red, 'host')).rejects.toMatchObject({
      code: 'ROOM_NOT_FOUND',
    });
    for (let index = 0; index < 12; index++) await rooms.create({ name: 'Guest' }, 'repeated');
    await expect(rooms.create({ name: 'Guest' }, 'repeated')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });

  it('does not commit a move or start a clock when scheduling the new deadline fails', async () => {
    await start({ mainTimeMs: 10_000 });
    const before = structuredClone(store.records.get(code));
    schedule.mockRejectedValueOnce(new Error('offline'));
    now += 100;
    await expect(move(red, 0, 54, 45)).rejects.toThrow('offline');
    expect(store.records.get(code)).toEqual(before);
  });

  it('does not mutate presence or emit room versions while reading a socket push snapshot', async () => {
    const first = (await rooms.read(code, red, 'host')).snapshot;
    now += 5_000;
    const push = (await rooms.read(code, red, 'host', false, false)).snapshot;
    expect(push.version).toBe(first.version);
    expect(push.expiresAt).toBe(first.expiresAt);
    expect(push.seats.red?.lastSeenAt).toBe(first.seats.red?.lastSeenAt);
    expect((await rooms.read(code, red, 'host')).snapshot.version).toBe(first.version + 1);
  });

  it('routes the one-move stalemate fixture through the real move validator and returns a loss', async () => {
    await rooms.installTestScenario(code, 'stalemate');
    const ended = (await move(red, 0, 15, 14)).snapshot;
    expect(ended.result).toEqual({ winner: 'red', reason: 'stalemate' });
  });

  it('ignores old game commands even when colors and move sequences match after two rematches', async () => {
    const original = (await start()).gameId;
    const branch = store.records.get(code)!.branchId;
    for (let game = 0; game < 2; game++) {
      await action('resign', {}, red);
      await action('rematch', { action: 'request' }, red);
      await action('rematch', { action: 'accept' }, black);
      if (game === 0) await start();
    }
    const current = store.records.get(code)!;
    expect(current.gameId).not.toBe(original);
    expect(current.seats.red?.displayName).toBe('Red');
    await rooms.action(code, 'ready', { ready: true, gameId: original }, red, 'host');
    expect(store.records.get(code)!.seats.red?.ready).toBe(false);
    await rooms.action(code, 'settings', { clockMode: 'untimed', gameId: original }, red, 'host');
    expect(store.records.get(code)!.settings.clockMode).toBe('increment');
    await start();
    await rooms.action(
      code,
      'move',
      {
        from: 54,
        to: 45,
        seq: 0,
        idempotencyKey: 'old_unprocessed',
        gameId: original,
        branchId: branch,
      },
      red,
      'host',
    );
    await rooms.action(code, 'resign', { gameId: original }, red, 'host');
    await rooms.action(code, 'draw', { action: 'offer', gameId: original }, red, 'host');
    expect(store.records.get(code)!.game.moves).toHaveLength(0);
    expect(store.records.get(code)!.status).toBe('playing');
    expect(store.records.get(code)!.pendingOffers.draw).toBeNull();
  });

  it('ignores an unprocessed move from an undone branch with the same sequence', async () => {
    const original = await start({ allowUndo: true });
    const delayed = {
      from: 54,
      to: 45,
      seq: 0,
      idempotencyKey: 'delayed_branch',
      gameId: original.gameId,
      branchId: original.branchId,
    };
    await move(red, 0, 56, 47);
    await action('undo', { action: 'offer' }, red);
    const undone = (await action('undo', { action: 'accept' }, black)).snapshot;
    expect(undone.branchId).not.toBe(original.branchId);
    const stale = await rooms.action(code, 'move', delayed, red, 'host');
    expect(stale.snapshot.game.moves).toHaveLength(0);
    expect((await move(red, 0, 54, 45, 'new_branch_move')).snapshot.game.moves).toHaveLength(1);
  });

  it('does not apply a delayed takeback acceptance to a newer offer in the same match', async () => {
    const original = await start({ allowUndo: true });
    await move(red, 0, 54, 45);
    const offer1 = (await action('undo', { action: 'offer' }, red)).snapshot.pendingOffers.undo!;
    await action('undo', { action: 'decline' }, black);
    await move(black, 1, 27, 36);
    const offer2 = (await action('undo', { action: 'offer' }, red)).snapshot.pendingOffers.undo!;
    await expect(
      rooms.action(
        code,
        'undo',
        { action: 'accept', offerId: offer1.id, gameId: original.gameId },
        black,
        'guest',
      ),
    ).rejects.toMatchObject({ code: 'NO_OFFER' });
    expect(store.records.get(code)!.game.moves).toHaveLength(2);
    expect(store.records.get(code)!.pendingOffers.undo?.id).toBe(offer2.id);
    expect((await action('undo', { action: 'accept' }, black)).snapshot.game.moves).toHaveLength(1);
  });
});

describe('storage and scheduled delivery boundaries', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('keeps file-backed rooms across service instances and rejects concurrent stale writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xiangqi-store-'));
    try {
      const path = join(directory, 'rooms.json');
      const first = new LocalRoomStore(path),
        second = new LocalRoomStore(path);
      const created = await new RoomService(first).create({ name: 'Persisted' }, 'local');
      const record = (await second.get(created.snapshot.code))!;
      expect(record.seats.red?.displayName).toBe('Persisted');
      const a = structuredClone(record),
        b = structuredClone(record);
      a.version++;
      b.version++;
      const committed = await Promise.all([
        first.compareAndSet(record.code, record.version, a),
        second.compareAndSet(record.code, record.version, b),
      ]);
      expect(committed.filter(Boolean)).toHaveLength(1);
      expect(await second.updates(record.code, '0-0')).toMatchObject({ version: 2 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fails safely when Redis is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(
      new RedisRoomStore('https://redis.example', 'secret').get('23456789AB'),
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE', status: 503 });
  });

  it('schedules a protected QStash callback no earlier than the server deadline', async () => {
    vi.stubEnv('QSTASH_TOKEN', 'scheduler-secret');
    vi.stubEnv('TIMEOUT_SECRET', 'callback-secret');
    vi.stubEnv('APP_BASE_URL', 'https://xiangqi.example');
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const store = new MemoryStore();
    let now = 2_000_000;
    const rooms = new RoomService(store, { now: () => now });
    const host = await rooms.create({ name: 'Red' }, 'red');
    const guest = await rooms.join(host.snapshot.code, { name: 'Black' }, undefined, 'black');
    await command(rooms, host.snapshot.code, 'ready', { ready: true }, host.token!, 'red');
    now += 123;
    await command(rooms, host.snapshot.code, 'ready', { ready: true }, guest.token!, 'black');
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v2/publish/https://xiangqi.example/api/internal/timeout-check');
    const headers = options.headers as Record<string, string>;
    const presenceDeadline = Math.min(
      ...Object.values(store.records.get(host.snapshot.code)!.seats)
        .filter((seat) => seat !== null)
        .map((seat) => seat.lastSeenAt + 30_000),
    );
    expect(headers['Upstash-Not-Before']).toBe(String(Math.ceil(presenceDeadline / 1_000)));
    expect(headers['Upstash-Forward-Authorization']).toBe('Bearer callback-secret');
    expect(options.body).toBe(JSON.stringify({ code: host.snapshot.code }));
    expect(options.body).not.toContain(host.token!);
    await expect(scheduleTimeout({} as RoomRecord)).resolves.toBeUndefined();
  });
});
