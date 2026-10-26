'use client';
import { useMemo, useRef, useState, type CSSProperties } from 'react';
import { legalMoves, type Color, type GameState, type Piece, type PieceType } from '@/lib/xiangqi';

export const PIECE_NAMES: Record<PieceType, string> = {
  general: 'General',
  advisor: 'Advisor',
  elephant: 'Elephant',
  horse: 'Horse',
  rook: 'Rook',
  cannon: 'Cannon',
  soldier: 'Soldier',
};
const characters: Record<Color, Record<PieceType, string>> = {
  red: {
    general: '帥',
    advisor: '仕',
    elephant: '相',
    horse: '傌',
    rook: '俥',
    cannon: '炮',
    soldier: '兵',
  },
  black: {
    general: '將',
    advisor: '士',
    elephant: '象',
    horse: '馬',
    rook: '車',
    cannon: '砲',
    soldier: '卒',
  },
};
const symbols: Record<PieceType, string> = {
  general: 'G',
  advisor: 'A',
  elephant: 'E',
  horse: 'H',
  rook: 'R',
  cannon: 'C',
  soldier: 'S',
};
export function squareName(index: number) {
  return `${'abcdefghi'[index % 9]}${9 - Math.floor(index / 9)}`;
}
export function pieceLabel(piece: Piece) {
  return `${piece.color === 'red' ? 'Red' : 'Black'} ${PIECE_NAMES[piece.type].toLowerCase()}`;
}

export function Board({
  game,
  flipped,
  onMove,
  canMove,
  pieceStyle,
  colorblind,
  theme,
}: {
  game: GameState;
  flipped: boolean;
  onMove: (from: number, to: number) => void;
  canMove: boolean;
  pieceStyle: 'characters' | 'symbols';
  colorblind: boolean;
  theme: 'ink' | 'jade' | 'paper';
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [focused, setFocused] = useState(81);
  const nodes = useRef<(SVGGElement | null)[]>([]);
  const moves = useMemo(
    () => (selected === null ? [] : legalMoves(game, selected)),
    [game, selected],
  );
  const targets = new Set(moves.map((move) => move.to));
  const last = game.moves.at(-1);
  function select(index: number) {
    if (!canMove) return;
    if (selected !== null && targets.has(index)) {
      onMove(selected, index);
      setSelected(null);
      return;
    }
    const piece = game.board[index];
    setSelected(piece?.color === game.turn ? (selected === index ? null : index) : null);
  }
  function keyboard(event: React.KeyboardEvent<SVGGElement>, index: number) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      select(index);
      return;
    }
    if (event.key === 'Escape') {
      setSelected(null);
      return;
    }
    const offsets: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -9,
      ArrowDown: 9,
    };
    if (!(event.key in offsets)) return;
    event.preventDefault();
    const delta = offsets[event.key] * (flipped ? -1 : 1);
    const next = index + delta;
    if (
      next < 0 ||
      next > 89 ||
      (Math.abs(delta) === 1 && Math.floor(next / 9) !== Math.floor(index / 9))
    )
      return;
    setFocused(next);
    nodes.current[next]?.focus();
  }
  const coords = (index: number) => ({
    x: 46 + (flipped ? 8 - (index % 9) : index % 9) * 54,
    y: 44 + (flipped ? 9 - Math.floor(index / 9) : Math.floor(index / 9)) * 54,
  });
  return (
    <div className={`board-wrap board-${theme} ${colorblind ? 'colorblind' : ''}`}>
      <svg
        className="xiangqi-board"
        viewBox="0 0 524 578"
        role="group"
        aria-label={`Xiangqi board. ${game.turn === 'red' ? 'Red' : 'Black'} to move. Use arrow keys, then Enter to select and move.`}
      >
        <rect className="board-ground" x="0" y="0" width="524" height="578" rx="8" />
        <g className="board-grid" fill="none" strokeWidth="1">
          {Array.from({ length: 10 }, (_, row) => (
            <path key={`h${row}`} d={`M46 ${44 + row * 54}H478`} />
          ))}
          {Array.from({ length: 9 }, (_, col) => (
            <path key={`v${col}`} d={`M${46 + col * 54} 44V260 M${46 + col * 54} 314V530`} />
          ))}
          <path d="M46 260v54M478 260v54M208 44l108 108m0-108L208 152M208 422l108 108m0-108L208 530" />
          {[1, 7, 19, 25, 27, 29, 31, 33, 35, 54, 56, 58, 60, 62, 64, 70, 82, 88]
            .filter((i) => Math.floor(i / 9) !== 0 && Math.floor(i / 9) !== 9)
            .map((index) => {
              const { x, y } = coords(index);
              return (
                <g key={`cross${index}`}>
                  <path
                    d={`M${x - 7} ${y - 14}v7h-7M${x + 7} ${y - 14}v7h7M${x - 7} ${y + 14}v-7h-7M${x + 7} ${y + 14}v-7h7`}
                  />
                </g>
              );
            })}
        </g>
        <g className="river-text" aria-hidden="true">
          <text x="154" y="294" textAnchor="middle">
            楚 河
          </text>
          <text x="370" y="294" textAnchor="middle">
            漢 界
          </text>
        </g>
        {Array.from({ length: 9 }, (_, col) => (
          <text
            className="board-coordinate"
            key={`c${col}`}
            x={46 + col * 54}
            y="564"
            textAnchor="middle"
          >
            {'abcdefghi'[flipped ? 8 - col : col]}
          </text>
        ))}
        {Array.from({ length: 10 }, (_, row) => (
          <text
            className="board-coordinate"
            key={`r${row}`}
            x="16"
            y={48 + row * 54}
            textAnchor="middle"
          >
            {flipped ? row : 9 - row}
          </text>
        ))}
        {game.board.map((piece, index) => {
          const { x, y } = coords(index);
          const isSelected = selected === index && piece?.color === game.turn;
          const isTarget = targets.has(index) && canMove;
          const moved = last?.to === index;
          const origin = moved && last ? coords(last.from) : { x, y };
          return (
            <g
              key={index}
              ref={(element) => {
                nodes.current[index] = element;
              }}
              transform={`translate(${x},${y})`}
              role="button"
              tabIndex={focused === index ? 0 : -1}
              aria-label={`${piece ? pieceLabel(piece) : 'Empty square'} at ${squareName(index)}${isTarget ? ', legal destination' : ''}`}
              aria-pressed={isSelected}
              data-square={index}
              className={`board-square ${piece ? 'occupied' : ''} ${isSelected ? 'selected' : ''} ${isTarget ? 'legal' : ''} ${piece?.color ?? ''} ${moved ? 'last-move' : ''}`}
              onClick={() => select(index)}
              onKeyDown={(event) => keyboard(event, index)}
              onFocus={() => setFocused(index)}
            >
              <rect
                className="square-hit"
                x="-27"
                y="-27"
                width="54"
                height="54"
                fill="transparent"
              />
              {last?.from === index && !piece && <circle className="origin-mark" r="7" />}
              {piece && (
                <g
                  key={`${index}-${moved ? game.moves.length : 'rest'}`}
                  className={`piece-face ${moved ? 'piece-moved' : ''}`}
                  style={
                    {
                      '--move-x': `${origin.x - x}px`,
                      '--move-y': `${origin.y - y}px`,
                    } as CSSProperties
                  }
                >
                  <circle className="piece-base" r="23.5" />
                  <circle className="piece-ring" r="19.8" fill="none" strokeWidth="1" />
                  {piece.color === 'black' && (
                    <circle
                      className="piece-ring inner-ring"
                      r="17.7"
                      fill="none"
                      strokeWidth=".6"
                    />
                  )}
                  <text
                    className={pieceStyle === 'characters' ? 'piece-character' : 'piece-symbol'}
                    textAnchor="middle"
                    dominantBaseline="central"
                    y="1"
                  >
                    {pieceStyle === 'characters'
                      ? characters[piece.color][piece.type]
                      : symbols[piece.type]}
                  </text>
                  {pieceStyle === 'symbols' && (
                    <text className="piece-side" x="0" y="17" textAnchor="middle">
                      {piece.color === 'red' ? 'R' : 'B'}
                    </text>
                  )}
                </g>
              )}
              {moved && last?.captured && (
                <circle
                  key={`capture-${game.moves.length}`}
                  className="capture-burst"
                  r="25"
                  fill="none"
                  strokeWidth="2"
                />
              )}
              {isTarget &&
                (piece ? (
                  <circle className="capture-target" r="26" fill="none" strokeWidth="3" />
                ) : (
                  <circle className="move-target" r="8" />
                ))}
              {isSelected && (
                <circle className="selection-ring" r="26" fill="none" strokeWidth="2.5" />
              )}
              <rect
                className="square-focus"
                x="-26"
                y="-26"
                width="52"
                height="52"
                rx="7"
                fill="none"
                strokeWidth="2"
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
