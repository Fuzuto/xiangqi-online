/** Pure Xiangqi rules shared by the browser and authoritative room service. */
export type Color = 'red' | 'black';
export type PieceType =
  'general' | 'advisor' | 'elephant' | 'horse' | 'rook' | 'cannon' | 'soldier';
export type Piece = { color: Color; type: PieceType };
export type Board = Array<Piece | null>;
export type MoveInput = { from: number; to: number };
export type Move = MoveInput & {
  piece: Piece;
  captured: Piece | null;
  notation: string;
  givesCheck: boolean;
};
export type HistoryEntry = { key: string; mover: Color | null; givesCheck: boolean };
export type GameState = {
  board: Board;
  turn: Color;
  history: HistoryEntry[];
  halfmoveClock: number;
  moves: Move[];
};
export type Result = { winner: Color | null; reason: string };

// WXF 2018 3.2.D / Article 8: 50 moves each, with only ten checks per player counted.
export const NO_CAPTURE_DRAW_PLIES = 100;
export const MAX_COUNTED_CHECKS_PER_PLAYER = 10;
// WXF 2018 3.2.B specifies four appearances, including the initial position.
export const REPETITION_OCCURRENCES = 4;

const ORTHOGONAL = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const;
const DIAGONAL = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
] as const;
const HORSE = [
  [-2, -1],
  [-2, 1],
  [2, -1],
  [2, 1],
  [-1, -2],
  [1, -2],
  [-1, 2],
  [1, 2],
] as const;
const PIECE_CODE: Record<PieceType, string> = {
  general: 'k',
  advisor: 'a',
  elephant: 'e',
  horse: 'h',
  rook: 'r',
  cannon: 'c',
  soldier: 's',
};

export function opposite(color: Color): Color {
  return color === 'red' ? 'black' : 'red';
}
const inside = (row: number, col: number) => row >= 0 && row < 10 && col >= 0 && col < 9;
const palace = (row: number, col: number, color: Color) =>
  col >= 3 && col <= 5 && (color === 'red' ? row >= 7 && row <= 9 : row >= 0 && row <= 2);
const crossedRiver = (row: number, color: Color) => (color === 'red' ? row <= 4 : row >= 5);

export function positionKey(state: Pick<GameState, 'board' | 'turn'>): string {
  return `${state.turn}:${state.board.map((p) => (p ? (p.color === 'red' ? PIECE_CODE[p.type].toUpperCase() : PIECE_CODE[p.type]) : '.')).join('')}`;
}

export function initialGame(): GameState {
  const board: Board = Array<Piece | null>(90).fill(null);
  const back: PieceType[] = [
    'rook',
    'horse',
    'elephant',
    'advisor',
    'general',
    'advisor',
    'elephant',
    'horse',
    'rook',
  ];
  for (const color of ['red', 'black'] as const) {
    const home = color === 'red' ? 9 : 0;
    back.forEach((type, col) => {
      board[home * 9 + col] = { color, type };
    });
    for (const col of [1, 7])
      board[(color === 'red' ? 7 : 2) * 9 + col] = { color, type: 'cannon' };
    for (const col of [0, 2, 4, 6, 8])
      board[(color === 'red' ? 6 : 3) * 9 + col] = { color, type: 'soldier' };
  }
  const state: GameState = { board, turn: 'red', history: [], halfmoveClock: 0, moves: [] };
  state.history.push({ key: positionKey(state), mover: null, givesCheck: false });
  return state;
}

function pseudoDestinations(board: Board, from: number): number[] {
  const piece = board[from];
  if (!piece) return [];
  const row = Math.floor(from / 9),
    col = from % 9,
    destinations: number[] = [];
  const add = (r: number, c: number) => {
    if (inside(r, c) && board[r * 9 + c]?.color !== piece.color) destinations.push(r * 9 + c);
  };
  switch (piece.type) {
    case 'rook':
    case 'cannon':
      for (const [dr, dc] of ORTHOGONAL) {
        let screened = false;
        for (let r = row + dr, c = col + dc; inside(r, c); r += dr, c += dc) {
          const target = board[r * 9 + c];
          if (piece.type === 'rook') {
            add(r, c);
            if (target) break;
          } else if (!screened) {
            if (target) screened = true;
            else add(r, c);
          } else if (target) {
            add(r, c);
            break;
          }
        }
      }
      break;
    case 'horse':
      for (const [dr, dc] of HORSE) {
        const legRow = row + (Math.abs(dr) === 2 ? Math.sign(dr) : 0);
        const legCol = col + (Math.abs(dc) === 2 ? Math.sign(dc) : 0);
        if (!board[legRow * 9 + legCol]) add(row + dr, col + dc);
      }
      break;
    case 'elephant':
      for (const [dr, dc] of DIAGONAL) {
        const r = row + 2 * dr,
          c = col + 2 * dc;
        if (inside(r, c) && !crossedRiver(r, piece.color) && !board[(row + dr) * 9 + col + dc])
          add(r, c);
      }
      break;
    case 'advisor':
      for (const [dr, dc] of DIAGONAL)
        if (palace(row + dr, col + dc, piece.color)) add(row + dr, col + dc);
      break;
    case 'general':
      for (const [dr, dc] of ORTHOGONAL)
        if (palace(row + dr, col + dc, piece.color)) add(row + dr, col + dc);
      break;
    case 'soldier':
      add(row + (piece.color === 'red' ? -1 : 1), col);
      if (crossedRiver(row, piece.color)) {
        add(row, col - 1);
        add(row, col + 1);
      }
      break;
  }
  return destinations;
}

export function isInCheck(board: Board, color: Color): boolean {
  const king = board.findIndex((p) => p?.color === color && p.type === 'general');
  if (king < 0) return true;
  const row = Math.floor(king / 9),
    col = king % 9,
    enemy = opposite(color);
  // Rays detect chariots, cannon screens, and the flying-general constraint.
  for (const [dr, dc] of ORTHOGONAL) {
    let screened = false;
    for (let r = row + dr, c = col + dc; inside(r, c); r += dr, c += dc) {
      const p = board[r * 9 + c];
      if (!p) continue;
      if (p.color === enemy) {
        if (
          !screened &&
          (p.type === 'rook' || (p.type === 'general' && (dc === 0 || Math.abs(c - col) === 1)))
        )
          return true;
        if (screened && p.type === 'cannon') return true;
      }
      if (screened) break;
      screened = true;
    }
  }
  for (const [dr, dc] of HORSE) {
    const r = row + dr,
      c = col + dc;
    if (!inside(r, c)) continue;
    const p = board[r * 9 + c];
    if (p?.color !== enemy || p.type !== 'horse') continue;
    const legRow = r - (Math.abs(dr) === 2 ? Math.sign(dr) : 0);
    const legCol = c - (Math.abs(dc) === 2 ? Math.sign(dc) : 0);
    if (!board[legRow * 9 + legCol]) return true;
  }
  // A pawn attacks forwards, and sideways only on the far side of the river.
  const soldierRow = row + (enemy === 'red' ? 1 : -1);
  if (inside(soldierRow, col)) {
    const p = board[soldierRow * 9 + col];
    if (p?.color === enemy && p.type === 'soldier') return true;
  }
  for (const c of [col - 1, col + 1]) {
    if (!inside(row, c) || !crossedRiver(row, enemy)) continue;
    const p = board[row * 9 + c];
    if (p?.color === enemy && p.type === 'soldier') return true;
  }
  return false;
}

export function legalMoves(state: GameState, from?: number): MoveInput[] {
  if (from !== undefined && (!Number.isInteger(from) || from < 0 || from >= 90)) return [];
  const moves: MoveInput[] = [];
  for (let i = from ?? 0; i < (from === undefined ? 90 : from + 1); i++) {
    if (state.board[i]?.color !== state.turn) continue;
    for (const to of pseudoDestinations(state.board, i)) {
      // Kings are never captured: checkmate/stalemate ends the game first.
      if (state.board[to]?.type === 'general') continue;
      const next = state.board.slice();
      next[to] = next[i];
      next[i] = null;
      if (!isInCheck(next, state.turn)) moves.push({ from: i, to });
    }
  }
  return moves;
}

export function squareName(square: number): string {
  return `${'abcdefghi'[square % 9]}${9 - Math.floor(square / 9)}`;
}

export function applyMove(state: GameState, input: MoveInput): GameState {
  if (
    !Number.isInteger(input.from) ||
    !Number.isInteger(input.to) ||
    !legalMoves(state, input.from).some((m) => m.to === input.to)
  )
    throw new Error('Illegal move');
  const piece = state.board[input.from]!;
  const captured = state.board[input.to];
  const board = state.board.slice();
  board[input.to] = piece;
  board[input.from] = null;
  const turn = opposite(state.turn),
    givesCheck = isInCheck(board, turn);
  const move: Move = {
    ...input,
    piece,
    captured,
    notation: `${squareName(input.from)}${captured ? '×' : '–'}${squareName(input.to)}${givesCheck ? '+' : ''}`,
    givesCheck,
  };
  const next: GameState = {
    board,
    turn,
    history: [],
    halfmoveClock: captured ? 0 : state.halfmoveClock + 1,
    moves: [...state.moves, move],
  };
  next.history = [...state.history, { key: positionKey(next), mover: state.turn, givesCheck }];
  return next;
}

/** WXF Article 8 excludes a player's checks beyond their first ten since a capture. */
export function naturalMoveCount(state: GameState): number {
  if (state.halfmoveClock === 0) return 0;
  const checks: Record<Color, number> = { red: 0, black: 0 };
  for (const move of state.moves.slice(-state.halfmoveClock))
    if (move.givesCheck) checks[move.piece.color]++;
  return (
    state.halfmoveClock -
    Math.max(0, checks.red - MAX_COUNTED_CHECKS_PER_PLAYER) -
    Math.max(0, checks.black - MAX_COUNTED_CHECKS_PER_PLAYER)
  );
}

/** Extension point: replace the neutral result here with full WXF chase adjudication. */
export function repetitionResult(state: GameState): Result | null {
  const key = positionKey(state),
    occurrences: number[] = [];
  state.history.forEach((entry, i) => {
    if (entry.key === key) occurrences.push(i);
  });
  if (occurrences.length < REPETITION_OCCURRENCES) return null;
  const cycle = state.history.slice(occurrences[occurrences.length - REPETITION_OCCURRENCES] + 1);
  const checking = (color: Color) => {
    const moves = cycle.filter((entry) => entry.mover === color);
    return moves.length > 0 && moves.every((entry) => entry.givesCheck);
  };
  const red = checking('red'),
    black = checking('black');
  if (red !== black) return { winner: red ? 'black' : 'red', reason: 'perpetual-check' };
  // shortcut: non-checking cycles are draws; upgrade this hook for full chase rules.
  return { winner: null, reason: 'repetition' };
}

export function gameResult(state: GameState): Result | null {
  if (legalMoves(state).length === 0)
    return {
      winner: opposite(state.turn),
      reason: isInCheck(state.board, state.turn) ? 'checkmate' : 'stalemate',
    };
  const repetition = repetitionResult(state);
  if (repetition) return repetition;
  if (naturalMoveCount(state) >= NO_CAPTURE_DRAW_PLIES)
    return { winner: null, reason: 'no-capture' };
  // Conservative 3.2.A case: only kings and palace/river-bound defensive pieces.
  if (state.board.every((p) => !p || ['general', 'advisor', 'elephant'].includes(p.type)))
    return { winner: null, reason: 'insufficient-material' };
  return null;
}
