import { describe, expect, it } from 'vitest';
import {
  applyMove,
  gameResult,
  initialGame,
  isInCheck,
  legalMoves,
  naturalMoveCount,
  NO_CAPTURE_DRAW_PLIES,
  positionKey,
  repetitionResult,
  type Board,
  type Color,
  type GameState,
  type PieceType,
} from './index';

function position(pieces: Array<[number, Color, PieceType]>, turn: Color = 'red'): GameState {
  const board: Board = Array(90).fill(null);
  for (const [square, color, type] of pieces) board[square] = { color, type };
  const state: GameState = { board, turn, moves: [], history: [], halfmoveClock: 0 };
  state.history = [{ key: positionKey(state), mover: null, givesCheck: false }];
  return state;
}
const kings: Array<[number, Color, PieceType]> = [
  [85, 'red', 'general'],
  [3, 'black', 'general'],
];
const destinations = (state: GameState, from: number) =>
  legalMoves(state, from).map((move) => move.to);

function fromFen(fen: string): GameState {
  const [layout, side] = fen.split(' ');
  const map: Record<string, PieceType> = {
    k: 'general',
    a: 'advisor',
    e: 'elephant',
    b: 'elephant',
    h: 'horse',
    n: 'horse',
    r: 'rook',
    c: 'cannon',
    p: 'soldier',
  };
  const pieces: Array<[number, Color, PieceType]> = [];
  let square = 0;
  for (const char of layout) {
    if (char === '/') continue;
    if (/\d/.test(char)) square += Number(char);
    else {
      pieces.push([
        square++,
        char === char.toUpperCase() ? 'red' : 'black',
        map[char.toLowerCase()],
      ]);
    }
  }
  return position(pieces, side === 'b' ? 'black' : 'red');
}

function perft(state: GameState, depth: number): number {
  if (depth === 0) return 1;
  const moves = legalMoves(state);
  if (depth === 1) return moves.length;
  return moves.reduce((sum, move) => sum + perft(applyMove(state, move), depth - 1), 0);
}

describe('published perft reference positions', () => {
  // Primary data: Nguyen Hong Pham, Jan 11 2026, independently verified in Pikafish:
  // https://www.talkchess.com/forum3/viewtopic.php?t=85880
  it('matches the starting position through three plies', () => {
    expect([1, 2, 3].map((depth) => perft(initialGame(), depth))).toEqual([44, 1920, 79666]);
  });
  it.each([
    ['r1ea1a3/4kh3/2h1e4/pHp1p1p1p/4c4/6P2/P1P2R2P/1CcC5/9/2EAKAE2 w', 38, 1128, 43929],
    ['1ceak4/9/h2a5/2p1p3p/5cp2/2h2H3/6PCP/3AE4/2C6/3A1K1H1 w', 7, 281, 8620],
    ['5a3/3k5/3aR4/9/5r3/5h3/9/3A1A3/5K3/2EC2E2 w', 25, 424, 9850],
    ['CRH1k1e2/3ca4/4ea3/9/2hr5/9/9/4E4/4A4/4KA3 w', 28, 516, 14808],
    ['C1hHk4/9/9/9/9/9/h1pp5/E3C4/9/3A1K3 w', 28, 222, 6241],
  ])('handles tactical and blocking position %s', (fen, one, two, three) => {
    expect([1, 2, 3].map((depth) => perft(fromFen(fen), depth))).toEqual([one, two, three]);
  });
});

describe('movement and king safety', () => {
  it('blocks both destinations behind a horse leg', () => {
    const free = position([...kings, [49, 'red', 'horse']]);
    expect(destinations(free, 49)).toEqual(expect.arrayContaining([30, 32]));
    const blocked = position([...kings, [49, 'red', 'horse'], [40, 'red', 'soldier']]);
    expect(destinations(blocked, 49)).not.toEqual(expect.arrayContaining([30, 32]));
    expect(destinations(blocked, 49)).not.toContain(30);
    expect(destinations(blocked, 49)).not.toContain(32);
  });
  it('blocks the elephant eye and prevents crossing the river', () => {
    const free = position([...kings, [67, 'red', 'elephant']]);
    expect(destinations(free, 67)).toContain(47);
    const blocked = position([...kings, [67, 'red', 'elephant'], [57, 'red', 'soldier']]);
    expect(destinations(blocked, 67)).not.toContain(47);
    const river = position([...kings, [49, 'red', 'elephant']]);
    expect(destinations(river, 49)).not.toContain(29);
    expect(destinations(river, 49)).not.toContain(33);
    expect(destinations(river, 49)).toContain(65);
  });
  it('requires exactly one screen for cannon captures', () => {
    const pieces: Array<[number, Color, PieceType]> = [
      ...kings,
      [45, 'red', 'cannon'],
      [53, 'black', 'rook'],
    ];
    expect(destinations(position(pieces), 45)).not.toContain(53);
    const screened = position([...pieces, [49, 'red', 'soldier']]);
    expect(destinations(screened, 45)).toContain(53);
    expect(destinations(screened, 45)).toContain(48);
    expect(destinations(screened, 45)).not.toContain(50);
    expect(destinations(screened, 45)).not.toContain(49);
    expect(
      destinations(position([...pieces, [49, 'red', 'soldier'], [51, 'black', 'soldier']]), 45),
    ).not.toContain(53);
  });
  it('limits generals and advisors to their palaces', () => {
    const state = position([...kings, [84, 'red', 'advisor']]);
    expect(destinations(state, 84)).toEqual([76]);
    expect(destinations(state, 85).sort()).toEqual([76, 86]);
    const edge = position([
      [66, 'red', 'general'],
      [4, 'black', 'general'],
    ]);
    expect(destinations(edge, 66)).not.toContain(57);
    expect(destinations(edge, 66)).not.toContain(65);
  });
  it('gives soldiers sideways moves only after crossing, and never backwards', () => {
    expect(destinations(position([...kings, [49, 'red', 'soldier']]), 49)).toEqual([40]);
    expect(destinations(position([...kings, [40, 'red', 'soldier']]), 40).sort()).toEqual([
      31, 39, 41,
    ]);
    expect(destinations(position([...kings, [40, 'black', 'soldier']], 'black'), 40)).toEqual([49]);
    expect(
      destinations(position([...kings, [49, 'black', 'soldier']], 'black'), 49).sort(),
    ).toEqual([48, 50, 58]);
  });
  it('detects facing generals and forbids moving the shielding piece sideways', () => {
    const state = position([
      [85, 'red', 'general'],
      [4, 'black', 'general'],
      [49, 'red', 'rook'],
    ]);
    expect(isInCheck(state.board, 'red')).toBe(false);
    expect(destinations(state, 49)).not.toContain(48);
    expect(destinations(state, 49)).toContain(40);
    const open = state.board.slice();
    open[49] = null;
    expect(isInCheck(open, 'red')).toBe(true);
    expect(isInCheck(open, 'black')).toBe(true);
    expect(() => applyMove(state, { from: 49, to: 48 })).toThrow('Illegal');
  });
  it('rejects pinned-piece moves leaving the general in check', () => {
    const state = position([...kings, [13, 'black', 'rook'], [49, 'red', 'rook']]);
    expect(destinations(state, 49)).not.toContain(48);
    expect(destinations(state, 49)).toContain(13);
  });
  it('requires a response to check and respects horse leg blocking in attacks', () => {
    const checked = position([...kings, [66, 'black', 'horse']]);
    expect(isInCheck(checked.board, 'red')).toBe(true);
    const blocked = position([...kings, [66, 'black', 'horse'], [75, 'red', 'rook']]);
    expect(isInCheck(blocked.board, 'red')).toBe(false);
  });
  it('does not mutate the input and records captures, turns and notation', () => {
    const state = initialGame(),
      original = JSON.stringify(state);
    const next = applyMove(state, { from: 64, to: 1 });
    expect(JSON.stringify(state)).toBe(original);
    expect(next.turn).toBe('black');
    expect(next.moves[0].captured?.type).toBe('horse');
    expect(next.moves[0].notation).toBe('b2×b9');
    expect(next.halfmoveClock).toBe(0);
    expect(next.history).toHaveLength(2);
  });
  it('rejects invalid coordinates, empty squares and opponent pieces', () => {
    const state = initialGame();
    for (const move of [
      { from: -1, to: 4 },
      { from: 0.5, to: 4 },
      { from: 4, to: 13 },
      { from: 45, to: 46 },
      { from: 85, to: 100 },
    ])
      expect(() => applyMove(state, move)).toThrow('Illegal');
  });
});

describe('adjudication', () => {
  it('treats stalemate as a loss, reached by a legal move', () => {
    const state = position([
      [4, 'black', 'general'],
      [85, 'red', 'general'],
      [40, 'red', 'soldier'],
      [12, 'red', 'rook'],
      [15, 'red', 'rook'],
    ]);
    const next = applyMove(state, { from: 15, to: 14 });
    expect(isInCheck(next.board, 'black')).toBe(false);
    expect(legalMoves(next)).toHaveLength(0);
    expect(gameResult(next)).toEqual({ winner: 'red', reason: 'stalemate' });
  });
  it('recognizes checkmate', () => {
    // Checkmate example from the evaluated BSD-2-Clause xiangqi.js API documentation:
    // https://github.com/lengyanyu258/xiangqi.js#in_checkmate
    const state = fromFen('rnbakab1r/9/1c5c1/p1p5p/4p1p2/4P1P2/P1P3nCP/1C3A3/4NK3/RNB2AB1R r');
    expect(isInCheck(state.board, 'red')).toBe(true);
    expect(gameResult(state)).toEqual({ winner: 'black', reason: 'checkmate' });
  });
  it('draws only conservative material positions without attacking pieces', () => {
    expect(
      gameResult(position([...kings, [87, 'red', 'elephant'], [5, 'black', 'advisor']])),
    ).toEqual({ winner: null, reason: 'insufficient-material' });
    expect(gameResult(position([...kings, [49, 'red', 'horse']]))).toBe(null);
  });
  it('draws a neutral repeated position on its fourth occurrence', () => {
    let state = initialGame();
    const cycle = [
      { from: 82, to: 65 },
      { from: 1, to: 18 },
      { from: 65, to: 82 },
      { from: 18, to: 1 },
    ];
    for (let i = 0; i < 2; i++) for (const move of cycle) state = applyMove(state, move);
    expect(repetitionResult(state)).toBe(null);
    for (const move of cycle) state = applyMove(state, move);
    expect(gameResult(state)).toEqual({ winner: null, reason: 'repetition' });
  });
  it('penalizes the side delivering perpetual check, independent of which side moves', () => {
    let state = position(
      [
        [4, 'black', 'general'],
        [85, 'red', 'general'],
        [49, 'red', 'soldier'],
        [12, 'red', 'rook'],
      ],
      'red',
    );
    // Red's rook follows the king between e9 and f9, checking on every move.
    const cycle = [
      { from: 12, to: 13 },
      { from: 4, to: 5 },
      { from: 13, to: 14 },
      { from: 5, to: 4 },
    ];
    // The cycle returns to the position after Red's first check, not the setup.
    state = applyMove(state, cycle[0]);
    for (let i = 0; i < 3; i++) {
      for (const move of [cycle[1], cycle[2], cycle[3], { from: 14, to: 13 }])
        state = applyMove(state, move);
    }
    expect(gameResult(state)).toEqual({ winner: 'black', reason: 'perpetual-check' });
  });
  it('draws mutual perpetual checks and ignores incomplete check cycles', () => {
    const state = initialGame(),
      key = positionKey(state);
    state.history = [{ key, mover: null, givesCheck: false }];
    for (let i = 0; i < 3; i++)
      state.history.push(
        { key: 'intermediate', mover: 'red', givesCheck: true },
        { key, mover: 'black', givesCheck: true },
      );
    expect(repetitionResult(state)).toEqual({ winner: null, reason: 'repetition' });
    state.history[1].givesCheck = false;
    expect(repetitionResult(state)).toEqual({ winner: 'red', reason: 'perpetual-check' });
  });
  it('uses the pinned 100-ply no-capture count and does not reset it for a soldier', () => {
    const state = initialGame();
    state.halfmoveClock = NO_CAPTURE_DRAW_PLIES - 1;
    expect(gameResult(state)).toBe(null);
    const next = applyMove(state, { from: 54, to: 45 });
    expect(next.halfmoveClock).toBe(100);
    expect(gameResult(next)).toEqual({ winner: null, reason: 'no-capture' });
  });
  it('excludes checks beyond ten per player from the natural move count', () => {
    const state = initialGame();
    state.halfmoveClock = 100;
    state.moves = Array.from({ length: 12 }, () => ({
      from: 0,
      to: 1,
      piece: { color: 'red', type: 'rook' },
      captured: null,
      notation: '',
      givesCheck: true,
    }));
    expect(naturalMoveCount(state)).toBe(98);
    expect(gameResult(state)).toBe(null);
    state.halfmoveClock = 102;
    expect(gameResult(state)).toEqual({ winner: null, reason: 'no-capture' });
  });
  it('clears the no-capture count on captures, including its excess checks', () => {
    const state = initialGame();
    state.halfmoveClock = 99;
    const next = applyMove(state, { from: 64, to: 1 });
    expect(naturalMoveCount(next)).toBe(0);
    expect(gameResult(next)).toBe(null);
  });
});
