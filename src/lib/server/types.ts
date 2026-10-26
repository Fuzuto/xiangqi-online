import type { Color, GameState, Piece } from '../xiangqi';

export type RoomStatus = 'waiting' | 'playing' | 'finished' | 'aborted';
export type ClockMode = 'untimed' | 'increment' | 'per-move';

export interface RoomSettings {
  clockMode: ClockMode;
  mainTimeMs: number;
  incrementMs: number;
  perMoveMs: number;
  hostSide: Color | 'random';
  allowUndo: boolean;
}

export interface RoomClocks {
  remaining: Record<Color, number>;
  turnStartedAt: number | null;
  turnRemainingMs: number | null;
}

export interface PublicSeat {
  id: string;
  displayName: string;
  ready: boolean;
  lastSeenAt: number;
  connected: boolean;
  disconnectDeadline: number | null;
}

export interface GameResult {
  winner: Color | null;
  reason: string;
}

export interface TimedMoveRecord {
  seq: number;
  from: number;
  to: number;
  capturedPiece: Piece | null;
  notation: string;
  timestamp: number;
  remainingMsAfter: Record<Color, number>;
}

export interface PendingOffers {
  draw: { id: string; by: Color; atMove: number } | null;
  undo: { id: string; by: Color; moveSeq: number } | null;
  rematch: Color[];
}

export interface RoomSnapshot {
  code: string;
  gameId: string;
  branchId: string;
  version: number;
  createdAt: number;
  expiresAt: number;
  serverNow: number;
  status: RoomStatus;
  settings: RoomSettings;
  seats: Record<Color, PublicSeat | null>;
  you: { id: string; color: Color; isHost: boolean; presenceId: string };
  game: GameState;
  moveLog: TimedMoveRecord[];
  clocks: RoomClocks;
  pendingOffers: PendingOffers;
  result: GameResult | null;
  abortUntil: number | null;
  storage: 'redis' | 'local';
  schedulingAvailable: boolean;
}

export interface RoomResponse {
  snapshot: RoomSnapshot;
  token?: string;
}

export type RoomAction =
  | 'settings'
  | 'ready'
  | 'move'
  | 'resign'
  | 'draw'
  | 'undo'
  | 'rematch'
  | 'abort'
  | 'claim'
  | 'leave';
