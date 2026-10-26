import type { Color, GameState } from '../xiangqi';
import type {
  GameResult,
  PendingOffers,
  RoomClocks,
  RoomSettings,
  RoomStatus,
  TimedMoveRecord,
} from './types';

export const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const ROOM_CODE_LENGTH = 10;
export const DISCONNECT_AFTER_MS = 12_000;
export const DISCONNECT_GRACE_MS = 90_000;
export const ABORT_WINDOW_MS = 30_000;
export const APPLY_INCREMENT_ON_FIRST_MOVE = false;
export const DRAW_OFFER_INTERVAL_PLIES = 20;

export const DEFAULT_SETTINGS: RoomSettings = {
  clockMode: 'increment',
  mainTimeMs: 600_000,
  incrementMs: 5_000,
  perMoveMs: 60_000,
  hostSide: 'red',
  allowUndo: false,
};

export interface SeatRecord {
  id: string;
  displayName: string;
  tokenHash: string;
  ready: boolean;
  connectedAt: number;
  lastSeenAt: number;
}

export interface UndoState {
  game: GameState;
  moveLog: TimedMoveRecord[];
  clocks: RoomClocks;
  moveCounts: Record<Color, number>;
}

export interface RoomRecord {
  code: string;
  gameId: string;
  branchId: string;
  version: number;
  createdAt: number;
  expiresAt: number;
  status: RoomStatus;
  settings: RoomSettings;
  hostId: string;
  seats: Record<Color, SeatRecord | null>;
  game: GameState;
  moveLog: TimedMoveRecord[];
  clocks: RoomClocks;
  pendingOffers: PendingOffers;
  result: GameResult | null;
  abortUntil: number | null;
  moveCounts: Record<Color, number>;
  lastDrawOfferAt: Record<Color, number>;
  processedMoves: Record<string, number>;
  undoState: UndoState | null;
}

export class RoomError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'RoomError';
  }
}

export function expiryMilliseconds() {
  const hours = Number(process.env.ROOM_EXPIRY_HOURS ?? 24);
  return (Number.isFinite(hours) && hours > 0 ? hours : 24) * 3_600_000;
}

export function startingClocks(settings: RoomSettings): RoomClocks {
  const time = settings.clockMode === 'per-move' ? settings.perMoveMs : settings.mainTimeMs;
  return { remaining: { red: time, black: time }, turnStartedAt: null, turnRemainingMs: null };
}

export function clockRemaining(room: RoomRecord, color: Color, now: number) {
  if (room.settings.clockMode === 'untimed') return null;
  if (
    room.status === 'playing' &&
    room.game.turn === color &&
    room.clocks.turnStartedAt !== null &&
    room.clocks.turnRemainingMs !== null
  ) {
    return Math.max(0, room.clocks.turnRemainingMs - (now - room.clocks.turnStartedAt));
  }
  return room.clocks.remaining[color];
}
