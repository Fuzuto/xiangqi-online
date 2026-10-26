import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { applyMove, gameResult, initialGame, opposite, positionKey } from '../xiangqi';
import type { Color } from '../xiangqi';
import {
  ABORT_WINDOW_MS,
  APPLY_INCREMENT_ON_FIRST_MOVE,
  DEFAULT_SETTINGS,
  DISCONNECT_GRACE_MS,
  DRAW_OFFER_INTERVAL_PLIES,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  RoomError,
  clockRemaining,
  disconnectDeadline,
  expiryMilliseconds,
  seatConnected,
  startingClocks,
} from './model';
import type { RoomRecord, SeatRecord } from './model';
import type { RoomAction, RoomResponse, RoomSettings, RoomSnapshot } from './types';
import type { RoomStore } from './store';
import {
  nextCheckDeadline,
  scheduleTimeout,
  schedulingAvailable,
  timeoutDeadline,
} from './scheduler';

const codeSchema = z.string().regex(/^[2-9A-HJ-NP-Z]{10}$/);
const nameSchema = z
  .string()
  .max(200)
  .transform((name) =>
    Array.from(
      name
        .replace(/[\p{Cc}\p{Cf}<>&]/gu, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
      .slice(0, 20)
      .join(''),
  )
  .pipe(z.string().min(1, 'Please enter a guest name.'));
const settingsSchema = z
  .object({
    clockMode: z.enum(['untimed', 'increment', 'per-move']),
    mainTimeMs: z.number().int().min(10_000).max(7_200_000),
    incrementMs: z.number().int().min(0).max(60_000),
    perMoveMs: z.number().int().min(1_000).max(600_000),
    hostSide: z.enum(['red', 'black', 'random']),
    allowUndo: z.boolean(),
  })
  .partial()
  .strict();
const moveSchema = z
  .object({
    from: z.number().int().min(0).max(89),
    to: z.number().int().min(0).max(89),
    seq: z.number().int().nonnegative(),
    idempotencyKey: z
      .string()
      .min(8)
      .max(128)
      .regex(/^[a-zA-Z0-9_-]+$/),
  })
  .strict();
const offerSchema = z
  .object({ action: z.enum(['offer', 'accept', 'decline']), offerId: z.string().uuid().optional() })
  .strict()
  .superRefine((value, context) => {
    if (value.action !== 'offer' && !value.offerId)
      context.addIssue({
        code: 'custom',
        message: 'An offer identifier is required.',
        path: ['offerId'],
      });
  });
const rematchSchema = z.object({ action: z.enum(['request', 'accept', 'decline']) }).strict();
const readySchema = z.object({ ready: z.boolean() }).strict();
const epochSchema = z
  .object({ gameId: z.string().uuid(), branchId: z.string().uuid().optional() })
  .passthrough();

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

export function secretsEqual(left: string, right: string) {
  const a = Buffer.from(digest(left), 'hex');
  const b = Buffer.from(digest(right), 'hex');
  return timingSafeEqual(a, b);
}

function seatForToken(
  room: RoomRecord,
  token: string | undefined,
): { color: Color; seat: SeatRecord } {
  if (!token || token.length > 200)
    throw new RoomError(
      'Your seat token is missing or invalid. Use the browser that joined this room.',
      'INVALID_TOKEN',
      401,
    );
  const hash = Buffer.from(digest(token), 'hex');
  for (const color of ['red', 'black'] as const) {
    const seat = room.seats[color];
    if (seat && timingSafeEqual(hash, Buffer.from(seat.tokenHash, 'hex'))) return { color, seat };
  }
  throw new RoomError(
    'Your seat token is invalid. Use the browser that joined this room.',
    'INVALID_TOKEN',
    401,
  );
}

function newSeat(name: string, now: number) {
  const token = randomBytes(32).toString('hex');
  const seat: SeatRecord = {
    id: randomUUID(),
    presenceId: randomUUID(),
    displayName: name,
    tokenHash: digest(token),
    ready: false,
    connectedAt: now,
    lastSeenAt: now,
  };
  return { token, seat };
}

function clearOffers(room: RoomRecord) {
  room.pendingOffers = { draw: null, undo: null, rematch: [] };
}

function finish(room: RoomRecord, winner: Color | null, reason: string, now: number) {
  if (room.status !== 'playing') return;
  const active = room.game.turn;
  const remaining = clockRemaining(room, active, now);
  if (remaining !== null) room.clocks.remaining[active] = remaining;
  room.status = 'finished';
  room.result = { winner, reason };
  room.clocks.turnStartedAt = null;
  room.clocks.turnRemainingMs = null;
  room.presenceCheckAt = null;
  clearOffers(room);
}

export function enforceTimeout(room: RoomRecord, now: number) {
  if (room.status !== 'playing') return false;
  const clockDeadline = timeoutDeadline(room);
  const absent = (['red', 'black'] as const).find((color) => {
    const seat = room.seats[color],
      opponent = room.seats[opposite(color)];
    return (
      seat &&
      opponent &&
      !seatConnected(seat, now) &&
      now >= disconnectDeadline(seat) &&
      seatConnected(opponent, now)
    );
  });
  const absenceDeadline = absent ? disconnectDeadline(room.seats[absent]!) : null;
  if (
    absenceDeadline !== null &&
    (clockDeadline === null || absenceDeadline < clockDeadline) &&
    now >= absenceDeadline
  ) {
    finish(room, opposite(absent!), 'disconnect', now);
    return true;
  }
  if (clockDeadline !== null && now >= clockDeadline) {
    finish(room, opposite(room.game.turn), 'timeout', now);
    return true;
  }
  return false;
}

function updatePresenceCheck(room: RoomRecord, now: number) {
  if (room.status !== 'playing') {
    room.presenceCheckAt = null;
    return;
  }
  if (room.presenceCheckAt != null && room.presenceCheckAt > now) return;
  const deadlines = Object.values(room.seats)
    .filter((seat): seat is SeatRecord => seat !== null)
    .map(disconnectDeadline)
    .filter((deadline) => deadline > now);
  room.presenceCheckAt = deadlines.length ? Math.min(...deadlines) : null;
}

export interface ServiceOptions {
  now?: () => number;
  schedule?: (room: RoomRecord) => Promise<void>;
}

export class RoomService {
  private now: () => number;
  private schedule: (room: RoomRecord) => Promise<void>;

  constructor(
    public readonly store: RoomStore,
    options: ServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? scheduleTimeout;
  }

  private async limit(ip: string, kind: 'create' | 'join' | 'read' | 'action', code?: string) {
    const now = this.now();
    const limits = { create: 12, join: 40, read: 180, action: 120 };
    if (
      !(await this.store.rateLimit(
        `ip:${digest(ip).slice(0, 24)}:${kind}`,
        limits[kind],
        60_000,
        now,
      ))
    ) {
      throw new RoomError(
        'Too many requests. Please wait a moment and retry.',
        'RATE_LIMITED',
        429,
      );
    }
    if (
      code &&
      !(await this.store.rateLimit(
        `room:${code}:${kind}`,
        kind === 'read' ? 300 : 160,
        60_000,
        now,
      ))
    ) {
      throw new RoomError(
        'This room has received too many requests. Please wait a moment.',
        'RATE_LIMITED',
        429,
      );
    }
  }

  private code(value: string) {
    const result = codeSchema.safeParse(value.toUpperCase());
    if (!result.success)
      throw new RoomError(
        'This room could not be found. Check the invitation code.',
        'ROOM_NOT_FOUND',
        404,
      );
    return result.data;
  }

  private async load(code: string, now: number) {
    const room = await this.store.get(code);
    if (!room)
      throw new RoomError(
        'This room could not be found. Check the invitation code.',
        'ROOM_NOT_FOUND',
        404,
      );
    if (room.expiresAt <= now)
      throw new RoomError(
        'This room has expired. Create a new room to play again.',
        'ROOM_EXPIRED',
        410,
      );
    room.moveLog ??= [];
    return room;
  }

  private snapshot(room: RoomRecord, token: string, now: number): RoomSnapshot {
    const { color, seat } = seatForToken(room, token);
    const publicSeat = (item: SeatRecord | null) =>
      item
        ? {
            id: item.id,
            displayName: item.displayName,
            ready: item.ready,
            lastSeenAt: item.lastSeenAt,
            connected: seatConnected(item, now),
            disconnectDeadline: seatConnected(item, now) ? null : disconnectDeadline(item),
          }
        : null;
    return {
      code: room.code,
      gameId: room.gameId,
      branchId: room.branchId,
      version: room.version,
      createdAt: room.createdAt,
      expiresAt: room.expiresAt,
      serverNow: now,
      status: room.status,
      settings: room.settings,
      seats: { red: publicSeat(room.seats.red), black: publicSeat(room.seats.black) },
      you: {
        id: seat.id,
        color,
        isHost: seat.id === room.hostId,
        presenceId: seat.presenceId ?? seat.id,
      },
      game: room.game,
      moveLog: room.moveLog,
      clocks: room.clocks,
      pendingOffers: room.pendingOffers,
      result: room.result,
      abortUntil: room.abortUntil,
      storage: this.store.kind,
      schedulingAvailable: schedulingAvailable(),
    };
  }

  private async transact(
    code: string,
    token: string,
    mutate: (room: RoomRecord, color: Color, now: number) => void,
    touchPresence = true,
    restorePresence = false,
  ): Promise<RoomResponse> {
    for (let attempt = 0; attempt < 12; attempt++) {
      const now = this.now();
      const room = await this.load(code, now);
      const { color, seat } = seatForToken(room, token);
      const previousVersion = room.version;
      const previousDeadline = nextCheckDeadline(room);
      const before = JSON.stringify(room);
      const timedOut = enforceTimeout(room, now);
      if (restorePresence) seat.presenceId = randomUUID();
      if (touchPresence && (seat.leftAt == null || restorePresence)) {
        // If both devices were gone, the first return starts a fresh grace period, not a free win.
        if (
          !timedOut &&
          room.status === 'playing' &&
          Object.values(room.seats).every(
            (item) => item && !seatConnected(item, now) && disconnectDeadline(item) <= now,
          )
        ) {
          const opponent = room.seats[opposite(color)];
          if (opponent) opponent.graceUntil = now + DISCONNECT_GRACE_MS;
        }
        if (now - seat.lastSeenAt >= 1_500 || seat.leftAt != null) seat.lastSeenAt = now;
        if (restorePresence || seat.leftAt == null) {
          seat.leftAt = null;
          seat.graceUntil = null;
        }
      }
      if (!timedOut) mutate(room, color, now);
      updatePresenceCheck(room, now);
      if (JSON.stringify(room) === before) return { snapshot: this.snapshot(room, token, now) };
      room.expiresAt = now + expiryMilliseconds();
      room.version++;
      // A failed scheduling attempt must not commit a new running deadline.
      if (nextCheckDeadline(room) !== previousDeadline) await this.schedule(room);
      if (await this.store.compareAndSet(code, previousVersion, room))
        return { snapshot: this.snapshot(room, token, now) };
    }
    throw new RoomError('Another action arrived at the same time. Please retry.', 'ROOM_BUSY', 409);
  }

  async create(input: unknown, ip: string): Promise<RoomResponse> {
    const { name } = z.object({ name: nameSchema }).strict().parse(input);
    await this.limit(ip, 'create');
    const now = this.now();
    const { seat, token } = newSeat(name, now);
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = Array.from(
        { length: ROOM_CODE_LENGTH },
        () => ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)],
      ).join('');
      const settings = { ...DEFAULT_SETTINGS };
      const room: RoomRecord = {
        code,
        gameId: randomUUID(),
        branchId: randomUUID(),
        version: 1,
        createdAt: now,
        expiresAt: now + expiryMilliseconds(),
        status: 'waiting',
        settings,
        hostId: seat.id,
        seats: { red: seat, black: null },
        game: initialGame(),
        moveLog: [],
        clocks: startingClocks(settings),
        pendingOffers: { draw: null, undo: null, rematch: [] },
        result: null,
        abortUntil: null,
        moveCounts: { red: 0, black: 0 },
        lastDrawOfferAt: { red: -DRAW_OFFER_INTERVAL_PLIES, black: -DRAW_OFFER_INTERVAL_PLIES },
        processedMoves: {},
        undoState: null,
      };
      if (await this.store.compareAndSet(code, null, room))
        return { snapshot: this.snapshot(room, token, now), token };
    }
    throw new RoomError('A room could not be created just now. Please retry.', 'ROOM_BUSY', 503);
  }

  async join(
    value: string,
    input: unknown,
    token: string | undefined,
    ip: string,
  ): Promise<RoomResponse> {
    const code = this.code(value);
    const parsed = z
      .object({ name: nameSchema.optional(), token: z.string().max(200).optional() })
      .strict()
      .parse(input);
    token ??= parsed.token;
    await this.limit(ip, 'join', code);
    if (token) return this.transact(code, token, () => {}, true, true);
    const name = nameSchema.parse(parsed.name);
    const now = this.now();
    const added = newSeat(name, now);
    for (let attempt = 0; attempt < 12; attempt++) {
      const room = await this.load(code, this.now());
      const version = room.version;
      enforceTimeout(room, this.now());
      const color = !room.seats.red ? 'red' : !room.seats.black ? 'black' : null;
      if (!color)
        throw new RoomError(
          'This room is full. Both player seats have already been claimed.',
          'ROOM_FULL',
          409,
        );
      if (room.status !== 'waiting')
        throw new RoomError('This game has already started.', 'GAME_STARTED', 409);
      room.seats[color] = added.seat;
      for (const seat of Object.values(room.seats)) if (seat) seat.ready = false;
      room.expiresAt = this.now() + expiryMilliseconds();
      room.version++;
      if (await this.store.compareAndSet(code, version, room))
        return { snapshot: this.snapshot(room, added.token, this.now()), token: added.token };
    }
    throw new RoomError('Another player joined at the same time. Please retry.', 'ROOM_BUSY', 409);
  }

  async read(value: string, token: string, ip: string, applyLimit = true, touchPresence = true) {
    const code = this.code(value);
    if (applyLimit) await this.limit(ip, 'read', code);
    return this.transact(code, token, () => {}, touchPresence);
  }

  async action(
    value: string,
    action: RoomAction,
    input: unknown,
    token: string,
    ip: string,
  ): Promise<RoomResponse> {
    const code = this.code(value);
    await this.limit(ip, 'action', code);
    const { gameId, branchId, ...payload } = epochSchema.parse(input);
    if (action === 'move') z.string().uuid().parse(branchId);
    const data = this.parseAction(action, payload);
    return this.transact(code, token, (room, color, now) => {
      // Delayed commands from an earlier game or an undone branch must never affect this one.
      if (room.gameId !== gameId || (action === 'move' && room.branchId !== branchId)) return;
      if (action === 'leave') {
        const seat = room.seats[color]!;
        if ((data as { presenceId: string }).presenceId !== (seat.presenceId ?? seat.id)) return;
        seat.leftAt = now;
        seat.graceUntil = now + DISCONNECT_GRACE_MS;
        for (const item of Object.values(room.seats)) if (item) item.ready = false;
        return;
      }
      if (action === 'settings')
        return this.changeSettings(room, color, data as Partial<RoomSettings>);
      if (action === 'ready')
        return this.setReady(room, color, (data as { ready: boolean }).ready, now);
      if (action === 'move') return this.move(room, color, data as z.infer<typeof moveSchema>, now);
      if (action === 'rematch')
        return this.rematch(room, color, (data as z.infer<typeof rematchSchema>).action);
      if (action === 'abort') {
        if (
          room.status !== 'playing' ||
          room.game.moves.length ||
          room.abortUntil === null ||
          now > room.abortUntil
        ) {
          throw new RoomError('The abort window has ended.', 'ABORT_UNAVAILABLE', 409);
        }
        room.status = 'aborted';
        room.result = null;
        room.clocks.turnStartedAt = null;
        room.clocks.turnRemainingMs = null;
        room.presenceCheckAt = null;
        clearOffers(room);
        return;
      }
      if (room.status !== 'playing')
        throw new RoomError('The game is not in progress.', 'GAME_NOT_PLAYING', 409);
      if (action === 'resign') return finish(room, opposite(color), 'resignation', now);
      if (action === 'claim') {
        if (enforceTimeout(room, now)) return;
        throw new RoomError(
          'The game ends automatically after a player has been away for 30 seconds.',
          'GRACE_PERIOD',
          409,
        );
      }
      if (action === 'draw') {
        const offer = data as z.infer<typeof offerSchema>;
        return this.draw(room, color, offer.action, now, offer.offerId);
      }
      if (action === 'undo') {
        const offer = data as z.infer<typeof offerSchema>;
        return this.undo(room, color, offer.action, now, offer.offerId);
      }
    });
  }

  private parseAction(action: RoomAction, input: unknown) {
    if (action === 'leave')
      return z.object({ presenceId: z.string().uuid() }).strict().parse(input);
    if (action === 'settings') return settingsSchema.parse(input);
    if (action === 'move') return moveSchema.parse(input);
    if (action === 'ready') return readySchema.parse(input);
    if (action === 'draw' || action === 'undo') return offerSchema.parse(input);
    if (action === 'rematch') return rematchSchema.parse(input);
    return z.object({}).strict().parse(input);
  }

  private changeSettings(room: RoomRecord, color: Color, settings: Partial<RoomSettings>) {
    if (room.status !== 'waiting')
      throw new RoomError('Match settings lock when the game begins.', 'SETTINGS_LOCKED', 409);
    if (room.seats[color]?.id !== room.hostId)
      throw new RoomError('Only the host can change match settings.', 'HOST_ONLY', 403);
    if (
      settings.perMoveMs !== undefined &&
      settings.perMoveMs < 10_000 &&
      process.env.E2E_TEST_MODE !== '1'
    ) {
      throw new RoomError('Choose at least 10 seconds per move.', 'INVALID_SETTINGS');
    }
    room.settings = { ...room.settings, ...settings };
    if (room.settings.hostSide !== 'random') this.assignHost(room, room.settings.hostSide);
    for (const seat of Object.values(room.seats)) if (seat) seat.ready = false;
    room.clocks = startingClocks(room.settings);
  }

  private assignHost(room: RoomRecord, side: Color) {
    if (room.seats[side]?.id !== room.hostId)
      [room.seats.red, room.seats.black] = [room.seats.black, room.seats.red];
  }

  private setReady(room: RoomRecord, color: Color, ready: boolean, now: number) {
    if (room.status !== 'waiting')
      throw new RoomError('This game has already started.', 'GAME_STARTED', 409);
    const seat = room.seats[color]!;
    if (!ready) {
      for (const item of Object.values(room.seats)) if (item) item.ready = false;
      return;
    }
    seat.ready = true;
    if (room.seats.red?.ready && room.seats.black?.ready) {
      if (!seatConnected(room.seats.red, now) || !seatConnected(room.seats.black, now)) {
        throw new RoomError('Both players must be connected to start.', 'PLAYER_DISCONNECTED', 409);
      }
      if (room.settings.hostSide === 'random')
        this.assignHost(room, randomInt(2) ? 'red' : 'black');
      room.status = 'playing';
      room.clocks = startingClocks(room.settings);
      room.clocks.turnStartedAt = room.settings.clockMode === 'untimed' ? null : now;
      room.clocks.turnRemainingMs =
        room.settings.clockMode === 'untimed' ? null : room.clocks.remaining.red;
      room.abortUntil = now + ABORT_WINDOW_MS;
    }
  }

  private move(room: RoomRecord, color: Color, move: z.infer<typeof moveSchema>, now: number) {
    const requestKey = `${room.seats[color]!.id}:${move.idempotencyKey}`;
    if (room.processedMoves[requestKey] !== undefined) return;
    // A stale move gets a full current snapshot so retries converge without a client error loop.
    if (move.seq !== room.game.moves.length) return;
    if (room.status !== 'playing')
      throw new RoomError('The game is not in progress.', 'GAME_NOT_PLAYING', 409);
    if (room.game.turn !== color)
      throw new RoomError('It is your opponent’s turn.', 'NOT_YOUR_TURN', 409);
    let next;
    try {
      next = applyMove(room.game, { from: move.from, to: move.to });
    } catch {
      throw new RoomError(
        'That move is not legal. Choose a highlighted destination.',
        'ILLEGAL_MOVE',
        409,
      );
    }
    const remaining = clockRemaining(room, color, now);
    room.undoState = {
      game: structuredClone(room.game),
      moveLog: structuredClone(room.moveLog),
      clocks: structuredClone(room.clocks),
      moveCounts: { ...room.moveCounts },
    };
    if (remaining !== null) {
      room.undoState.clocks.remaining[color] = remaining;
      room.undoState.clocks.turnRemainingMs = remaining;
      room.undoState.clocks.turnStartedAt = now;
      room.clocks.remaining[color] = remaining;
      if (
        room.settings.clockMode === 'increment' &&
        (APPLY_INCREMENT_ON_FIRST_MOVE || room.moveCounts[color] > 0)
      ) {
        room.clocks.remaining[color] += room.settings.incrementMs;
      }
      if (room.settings.clockMode === 'per-move')
        room.clocks.remaining[opposite(color)] = room.settings.perMoveMs;
      room.clocks.turnStartedAt = now;
      room.clocks.turnRemainingMs = room.clocks.remaining[opposite(color)];
    }
    room.game = next;
    room.moveCounts[color]++;
    const played = next.moves.at(-1)!;
    room.moveLog.push({
      seq: next.moves.length,
      from: played.from,
      to: played.to,
      capturedPiece: played.captured,
      notation: played.notation,
      timestamp: now,
      remainingMsAfter: { ...room.clocks.remaining },
    });
    room.processedMoves[requestKey] = room.game.moves.length;
    room.pendingOffers.undo = null;
    const result = gameResult(room.game);
    if (result) finish(room, result.winner, result.reason, now);
  }

  private draw(
    room: RoomRecord,
    color: Color,
    action: z.infer<typeof offerSchema>['action'],
    now: number,
    offerId?: string,
  ) {
    const offer = room.pendingOffers.draw;
    if (action === 'offer') {
      if (offer)
        throw new RoomError('There is already a draw offer to answer.', 'OFFER_PENDING', 409);
      if (room.game.moves.length - room.lastDrawOfferAt[color] < DRAW_OFFER_INTERVAL_PLIES) {
        throw new RoomError(
          'Wait ten full moves before offering another draw.',
          'DRAW_COOLDOWN',
          409,
        );
      }
      room.pendingOffers.draw = { id: randomUUID(), by: color, atMove: room.game.moves.length };
      room.lastDrawOfferAt[color] = room.game.moves.length;
    } else {
      if (!offer || offer.by === color || offer.id !== offerId)
        throw new RoomError('That draw offer is no longer available.', 'NO_OFFER', 409);
      if (action === 'accept') finish(room, null, 'agreement', now);
      else room.pendingOffers.draw = null;
    }
  }

  private undo(
    room: RoomRecord,
    color: Color,
    action: z.infer<typeof offerSchema>['action'],
    now: number,
    offerId?: string,
  ) {
    if (!room.settings.allowUndo)
      throw new RoomError('Takebacks are disabled for this room.', 'UNDO_DISABLED', 409);
    const offer = room.pendingOffers.undo;
    if (action === 'offer') {
      if (!room.undoState || !room.game.moves.length)
        throw new RoomError('There is no move to take back.', 'UNDO_UNAVAILABLE', 409);
      if (offer)
        throw new RoomError('There is already a takeback request to answer.', 'OFFER_PENDING', 409);
      room.pendingOffers.undo = { id: randomUUID(), by: color, moveSeq: room.game.moves.length };
    } else {
      if (
        !offer ||
        offer.by === color ||
        offer.id !== offerId ||
        !room.undoState ||
        offer.moveSeq !== room.game.moves.length
      ) {
        throw new RoomError('There is no opponent takeback request to answer.', 'NO_OFFER', 409);
      }
      if (action === 'accept') {
        // shortcut: only the latest ply can be taken back; a new move enables another request.
        room.game = room.undoState.game;
        room.moveLog = room.undoState.moveLog ?? room.moveLog.slice(0, -1);
        room.clocks = room.undoState.clocks;
        room.moveCounts = room.undoState.moveCounts;
        room.branchId = randomUUID();
        if (room.settings.clockMode !== 'untimed') room.clocks.turnStartedAt = now;
        room.undoState = null;
        room.pendingOffers.draw = null;
      }
      room.pendingOffers.undo = null;
    }
  }

  private rematch(room: RoomRecord, color: Color, action: z.infer<typeof rematchSchema>['action']) {
    if (room.status !== 'finished' && room.status !== 'aborted')
      throw new RoomError(
        'Finish this game before requesting a rematch.',
        'REMATCH_UNAVAILABLE',
        409,
      );
    if (action === 'decline') {
      room.pendingOffers.rematch = [];
      return;
    }
    if (action === 'accept' && !room.pendingOffers.rematch.includes(opposite(color)))
      throw new RoomError('There is no opponent rematch request to answer.', 'NO_OFFER', 409);
    if (!room.pendingOffers.rematch.includes(color)) room.pendingOffers.rematch.push(color);
    if (room.pendingOffers.rematch.length < 2) return;
    [room.seats.red, room.seats.black] = [room.seats.black, room.seats.red];
    for (const seat of Object.values(room.seats)) if (seat) seat.ready = false;
    room.settings.hostSide = room.seats.red?.id === room.hostId ? 'red' : 'black';
    room.gameId = randomUUID();
    room.branchId = randomUUID();
    room.status = 'waiting';
    room.game = initialGame();
    room.moveLog = [];
    room.result = null;
    room.abortUntil = null;
    room.clocks = startingClocks(room.settings);
    clearOffers(room);
    room.moveCounts = { red: 0, black: 0 };
    room.undoState = null;
    room.presenceCheckAt = null;
    room.lastDrawOfferAt = { red: -DRAW_OFFER_INTERVAL_PLIES, black: -DRAW_OFFER_INTERVAL_PLIES };
    room.processedMoves = {};
  }

  async checkTimeout(value: string) {
    const code = this.code(value);
    for (let attempt = 0; attempt < 12; attempt++) {
      const now = this.now();
      const room = await this.store.get(code);
      if (!room || room.expiresAt <= now) return { finalized: false };
      const version = room.version;
      const previousDeadline = nextCheckDeadline(room);
      const before = JSON.stringify(room);
      const finalized = enforceTimeout(room, now);
      updatePresenceCheck(room, now);
      // A rolling check follows heartbeats without scheduling a job for every heartbeat.
      if (
        !finalized &&
        room.status === 'playing' &&
        previousDeadline !== null &&
        previousDeadline <= now
      )
        await this.schedule(room);
      if (JSON.stringify(room) === before) return { finalized: false };
      room.version++;
      if (await this.store.compareAndSet(code, version, room)) return { finalized };
    }
    throw new RoomError('The room is busy. Please retry.', 'ROOM_BUSY', 409);
  }

  async installTestScenario(value: string, scenario: 'stalemate' | 'timeout') {
    const code = this.code(value);
    const now = this.now();
    const room = await this.load(code, now);
    const version = room.version;
    if (!room.seats.red || !room.seats.black)
      throw new RoomError('Two test players are required.', 'TEST_SETUP');
    room.status = 'playing';
    room.result = null;
    clearOffers(room);
    if (scenario === 'stalemate') {
      const game = initialGame();
      game.board = Array.from({ length: 90 }, () => null);
      game.board[4] = { color: 'black', type: 'general' };
      game.board[85] = { color: 'red', type: 'general' };
      game.board[40] = { color: 'red', type: 'soldier' };
      game.board[12] = { color: 'red', type: 'rook' };
      game.board[15] = { color: 'red', type: 'rook' };
      game.history = [{ key: positionKey(game), mover: null, givesCheck: false }];
      room.game = game;
      room.moveLog = [];
      room.settings.clockMode = 'untimed';
      room.clocks = startingClocks(room.settings);
    } else {
      room.settings.clockMode = 'per-move';
      room.settings.perMoveMs = 1_000;
      room.clocks = startingClocks(room.settings);
      room.clocks.turnStartedAt = now;
      room.clocks.turnRemainingMs = 1_000;
    }
    room.version++;
    if (!(await this.store.compareAndSet(code, version, room)))
      throw new RoomError('Retry the fixture.', 'ROOM_BUSY', 409);
    return { ok: true };
  }
}
