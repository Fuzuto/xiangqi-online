import type { CSSProperties } from 'react';
type IconName =
  | 'board'
  | 'arrow'
  | 'link'
  | 'sound'
  | 'muted'
  | 'flip'
  | 'settings'
  | 'help'
  | 'close'
  | 'back'
  | 'check'
  | 'copy'
  | 'flag'
  | 'undo'
  | 'draw'
  | 'refresh'
  | 'chevron'
  | 'menu';
const paths: Record<IconName, string> = {
  board: 'M4 3h16v18H4zM4 9h16M4 15h16M9 3v18M15 3v18',
  arrow: 'M4 12h16m-6-6 6 6-6 6',
  link: 'm10 13 4-4M9 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 10a4 4 0 0 0 6 0l5-5a4 4 0 0 0-6-6l-2 2',
  sound: 'M4 9h4l5-4v14l-5-4H4zM17 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14',
  muted: 'M4 9h4l5-4v14l-5-4H4zM17 9l6 6m0-6-6 6',
  flip: 'M7 4h13l-4-3m4 3-4 4M17 20H4l4-4m-4 4 4 3M4 8v5m16-2v5',
  settings:
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M9 2h6l1 4 4 1 2 5-3 3v4l-5 3-3-3H7l-4-4 1-4-2-3 3-5z',
  help: 'M9 8a3 3 0 1 1 5 2c-2 1-2 2-2 3m0 4v.1M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20',
  close: 'm6 6 12 12M18 6 6 18',
  back: 'm10 5-7 7 7 7M3 12h18',
  check: 'm5 12 4 4L19 6',
  copy: 'M8 8h12v13H8zM16 8V3H3v13h5',
  flag: 'M5 21V3c5-3 8 3 14 0v10c-6 3-9-3-14 0',
  undo: 'M9 4 3 10l6 6M3 10h11a6 6 0 0 1 0 12',
  draw: 'M4 8h16M4 16h16',
  refresh: 'M20 8a8 8 0 1 0 0 8M20 2v6h-6',
  chevron: 'm9 5 7 7-7 7',
  menu: 'M4 6h16M4 12h16M4 18h16',
};
export function Icon({
  name,
  size = 18,
  style,
}: {
  name: IconName;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.55"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      <path d={paths[name]} />
    </svg>
  );
}
