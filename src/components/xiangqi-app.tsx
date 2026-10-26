'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  applyMove,
  gameResult,
  initialGame,
  isInCheck,
  opposite,
  type Color,
  type GameState,
} from '@/lib/xiangqi';
import { useRoom } from '@/lib/use-room';
import { playSound, unlockSound, type SoundName } from '@/lib/sound';
import type { RoomSettings, RoomSnapshot } from '@/lib/server/types';
import { Board, PIECE_NAMES } from './board';
import { Icon } from './icon';

type Preferences = {
  theme: 'ink' | 'jade' | 'paper';
  pieceStyle: 'characters' | 'symbols';
  colorblind: boolean;
  volume: number;
  muted: boolean;
  alerts: boolean;
};
const defaults: Preferences = {
  theme: 'ink',
  pieceStyle: 'characters',
  colorblind: false,
  volume: 0.45,
  muted: false,
  alerts: true,
};
const settingDefaults: RoomSettings = {
  clockMode: 'increment',
  mainTimeMs: 600000,
  incrementMs: 5000,
  perMoveMs: 60000,
  hostSide: 'red',
  allowUndo: false,
};
function sideName(side: Color) {
  return side === 'red' ? 'Red' : 'Black';
}
function clockText(milliseconds: number | null) {
  if (milliseconds === null) return '—';
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}
function clockDescription(settings: RoomSettings) {
  return settings.clockMode === 'untimed'
    ? 'Untimed'
    : settings.clockMode === 'per-move'
      ? `${settings.perMoveMs / 1000}s per move`
      : `${settings.mainTimeMs / 60000} min + ${settings.incrementMs / 1000}s`;
}
function remaining(room: RoomSnapshot | null, side: Color, now: number) {
  if (!room || room.settings.clockMode === 'untimed') return null;
  const value = room.clocks.remaining[side];
  return room.status === 'playing' && room.game.turn === side && room.clocks.turnStartedAt !== null
    ? Math.max(0, (room.clocks.turnRemainingMs ?? value) - (now - room.clocks.turnStartedAt))
    : value;
}

export function XiangqiApp() {
  const room = useRoom();
  const { leave: leaveRoom } = room;
  const [localGame, setLocalGame] = useState<GameState>(initialGame);
  const [preferences, setPreferences] = useState<Preferences>(defaults);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [name, setName] = useState('');
  const [flipped, setFlipped] = useState(false);
  const [now, setNow] = useState(0);
  const [panel, setPanel] = useState<'appearance' | 'rules' | null>(null);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [soundUnlocked, setSoundUnlocked] = useState(false);
  const [announcement, setAnnouncement] = useState('A table for two. A little time to think.');
  const [confirmation, setConfirmation] = useState<'resign' | 'reset' | 'leave' | null>(null);
  const [copied, setCopied] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<RoomSettings>(settingDefaults);
  const [localResult, setLocalResult] = useState<ReturnType<typeof gameResult>>(null);
  const [boardResetId, setBoardResetId] = useState(0);
  const [returnNotice, setReturnNotice] = useState<{ title: string; description: string } | null>(
    null,
  );
  const snapshot = room.snapshot;
  const game = snapshot?.game ?? localGame;
  const result = snapshot ? snapshot.result : localResult;
  const resetLocalBoard = useCallback(() => {
    setLocalGame(initialGame());
    setLocalResult(null);
    setFlipped(false);
    setBoardResetId((value) => value + 1);
    setAnnouncement('A fresh board. Red to move.');
  }, []);
  const returnHome = useCallback(
    (notify = true) => {
      resetLocalBoard();
      setPanel(null);
      setMobileMenu(false);
      setConfirmation(null);
      if (notify) setReturnNotice(null);
      leaveRoom(notify);
      window.scrollTo({ top: 0, behavior: 'instant' });
    },
    [leaveRoom, resetLocalBoard],
  );
  const forfeitedGameId = snapshot?.result?.reason === 'disconnect' ? snapshot.gameId : null;
  const forfeitedWinner = snapshot?.result?.winner;
  const ownColor = snapshot?.you.color;
  const opponentName =
    snapshot?.seats[opposite(snapshot.you.color)]?.displayName ?? 'Your opponent';
  useEffect(() => {
    if (!forfeitedGameId || !ownColor) return;
    setReturnNotice({
      title: forfeitedWinner === ownColor ? 'You win' : 'Game over',
      description:
        forfeitedWinner === ownColor
          ? `${opponentName} was disconnected for 30 seconds. A fresh table is ready.`
          : 'You were disconnected for 30 seconds. The match has ended.',
    });
    const timer = setTimeout(() => returnHome(false), 1600);
    return () => clearTimeout(timer);
  }, [forfeitedGameId, forfeitedWinner, ownColor, opponentName, returnHome]);
  const previous = useRef<RoomSnapshot | null>(null);
  const alertedLow = useRef('');
  const soundPrefs = useRef(preferences);
  useEffect(() => {
    soundPrefs.current = preferences;
  }, [preferences]);
  const lastMoveElement = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('xiangqi-appearance') ?? 'null');
      if (stored) setPreferences({ ...defaults, ...stored });
      setName(localStorage.getItem('xiangqi-name') ?? '');
    } catch {
      /* Keep defaults when storage is unavailable. */
    }
    setPreferencesLoaded(true);
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (preferencesLoaded)
      try {
        localStorage.setItem('xiangqi-appearance', JSON.stringify(preferences));
      } catch {
        /* Preferences remain available for this visit. */
      }
  }, [preferences, preferencesLoaded]);
  const remoteSettings = snapshot ? JSON.stringify(snapshot.settings) : '';
  useEffect(() => {
    if (remoteSettings) setSettingsDraft(JSON.parse(remoteSettings));
  }, [remoteSettings]);
  useEffect(() => {
    if (snapshot) setFlipped(snapshot.you.color === 'black');
  }, [snapshot?.you.color, snapshot?.code]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const list = lastMoveElement.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [game.moves.length]);
  function sound(kind: SoundName) {
    const prefs = soundPrefs.current;
    if (!prefs.muted && (prefs.alerts || kind === 'move' || kind === 'capture'))
      playSound(kind, prefs.volume);
  }
  useEffect(() => {
    if (!snapshot) {
      previous.current = null;
      return;
    }
    const before = previous.current;
    previous.current = snapshot;
    if (!before || before.code !== snapshot.code) {
      setAnnouncement(
        snapshot.status === 'waiting'
          ? 'Your seat is saved. Invite a friend, then get ready.'
          : 'Seat restored. Your game is up to date.',
      );
      return;
    }
    if (before.status !== 'playing' && snapshot.status === 'playing')
      setAnnouncement('Both players ready. Red to move.');
    if (before.status !== 'aborted' && snapshot.status === 'aborted')
      setAnnouncement('The game was cancelled with no result.');
    const opponent = opposite(snapshot.you.color);
    if (!before.seats[opponent] && snapshot.seats[opponent]) {
      setAnnouncement('Your friend joined the table.');
      sound('join');
    }
    if (before.seats[opponent]?.connected && !snapshot.seats[opponent]?.connected) {
      setAnnouncement('Your opponent disconnected. Their clock keeps running.');
      sound('disconnect');
    }
    if (!before.seats[opponent]?.connected && snapshot.seats[opponent]?.connected)
      setAnnouncement('Your opponent is back at the table.');
    if (snapshot.game.moves.length > before.game.moves.length) {
      const move = snapshot.game.moves.at(-1)!;
      sound(move.givesCheck ? 'check' : move.captured ? 'capture' : 'move');
      setAnnouncement(
        move.givesCheck
          ? `${sideName(snapshot.game.turn)} is in check.`
          : `${sideName(move.piece.color)} moved ${PIECE_NAMES[move.piece.type].toLowerCase()}. ${sideName(snapshot.game.turn)} to move.`,
      );
      if (snapshot.game.turn === snapshot.you.color) sound('turn');
    }
    if (!before.result && snapshot.result) {
      sound(
        snapshot.result.winner === null
          ? 'draw'
          : snapshot.result.winner === snapshot.you.color
            ? 'win'
            : 'lose',
      );
      setAnnouncement(
        snapshot.result.winner
          ? `${sideName(snapshot.result.winner)} wins by ${snapshot.result.reason}.`
          : `Draw by ${snapshot.result.reason}.`,
      );
    }
  }, [snapshot]);
  const serverNow = now + room.clockOffset;
  const ownTime = snapshot ? remaining(snapshot, snapshot.you.color, serverNow) : null;
  useEffect(() => {
    if (
      !snapshot ||
      snapshot.status !== 'playing' ||
      snapshot.game.turn !== snapshot.you.color ||
      ownTime === null ||
      ownTime > 10000 ||
      ownTime <= 0
    )
      return;
    const key = `${snapshot.code}:${snapshot.game.moves.length}`;
    if (alertedLow.current !== key) {
      alertedLow.current = key;
      setAnnouncement('Ten seconds remaining.');
      sound('low');
    }
  }, [snapshot, ownTime]);
  async function enableSound() {
    try {
      setSoundUnlocked(await unlockSound());
    } catch {
      setAnnouncement('Sound is unavailable in this browser. Visual alerts are on.');
    }
  }
  function changePreference<K extends keyof Preferences>(key: K, value: Preferences[K]) {
    setPreferences((previous) => ({ ...previous, [key]: value }));
  }
  async function move(from: number, to: number) {
    if (!soundUnlocked) void enableSound();
    if (snapshot) {
      await room.action('move', {
        from,
        to,
        seq: game.moves.length,
        idempotencyKey: crypto.randomUUID(),
      });
      return;
    }
    try {
      const next = applyMove(localGame, { from, to });
      setLocalGame(next);
      const ended = gameResult(next);
      setLocalResult(ended);
      const move = next.moves.at(-1)!;
      sound(ended ? 'win' : move.givesCheck ? 'check' : move.captured ? 'capture' : 'move');
      setAnnouncement(
        ended
          ? ended.winner
            ? `${sideName(ended.winner)} wins by ${ended.reason}.`
            : `Draw by ${ended.reason}.`
          : `${sideName(next.turn)} to move${move.givesCheck ? ' — check' : ''}.`,
      );
    } catch (error) {
      room.setError(error instanceof Error ? error.message : 'That move is not legal.');
    }
  }
  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/?room=${snapshot!.code}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setAnnouncement('Select and copy the invite link below.');
    }
  }
  const checked = isInCheck(game.board, game.turn);
  const displayFlipped = flipped;
  const bottomSide: Color = displayFlipped ? 'black' : 'red';
  const topSide = opposite(bottomSide);
  const activeStatus = snapshot?.status ?? (localResult ? 'finished' : 'playing');
  const statusTitle = result
    ? result.winner
      ? `${sideName(result.winner)} wins`
      : 'A drawn game'
    : activeStatus === 'aborted'
      ? 'Game cancelled'
      : activeStatus === 'waiting'
        ? 'Waiting at the table'
        : `${sideName(game.turn)} to move`;
  const canMove =
    !room.busy &&
    activeStatus === 'playing' &&
    !result &&
    (!snapshot || snapshot.you.color === game.turn);
  function player(side: Color) {
    const seat = snapshot?.seats[side];
    const active = game.turn === side && activeStatus === 'playing' && !result;
    const time = remaining(snapshot, side, serverNow);
    const presence = !snapshot
      ? 'Local player'
      : !seat
        ? 'Waiting for a friend'
        : activeStatus === 'waiting'
          ? seat.ready
            ? 'Ready to play'
            : 'Choosing settings'
          : !seat.connected
            ? 'Disconnected'
            : active
              ? 'Thinking…'
              : 'At the table';
    return (
      <div className={`player-row ${active ? 'active-player' : ''}`}>
        <div className={`player-avatar ${side}`} aria-hidden="true">
          {side === 'red' ? '帥' : '將'}
        </div>
        <div className="player-identity">
          <strong>
            {snapshot
              ? (seat?.displayName ?? 'Open seat')
              : side === 'red'
                ? 'Red pieces'
                : 'Black pieces'}
            {snapshot?.you.color === side && <span className="you-label">You</span>}
          </strong>
          <span>
            {presence}
            <span className={`side-dot ${side}`} />
          </span>
        </div>
        <div
          className={`clock ${active ? 'clock-active' : ''} ${time !== null && time <= 10000 ? 'low-time' : ''}`}
          aria-label={`${sideName(side)} clock ${clockText(time)}`}
        >
          {clockText(time)}
          {active && time !== null && <span className="clock-tick" />}
        </div>
      </div>
    );
  }
  const opponent = snapshot?.seats[opposite(snapshot.you.color)];
  const disconnectSeconds =
    opponent && !opponent.connected
      ? Math.max(
          0,
          Math.ceil(
            ((opponent.disconnectDeadline ?? opponent.lastSeenAt + 30000) - serverNow) / 1000,
          ),
        )
      : 0;
  const draw = snapshot?.pendingOffers.draw;
  const undo = snapshot?.pendingOffers.undo;

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileMenu ? 'mobile-open' : ''}`}>
        <Link
          href="/"
          className="wordmark"
          onClick={(event) => {
            event.preventDefault();
            if (snapshot) setConfirmation('leave');
            else setPanel(null);
          }}
        >
          <span className="brand-mark" aria-hidden="true">
            象
          </span>
          <span>
            Xiangqi<span className="wordmark-sub">Online</span>
          </span>
        </Link>
        <div className="sidebar-body">
          <p className="nav-group-label">Your table</p>
          <button
            className={`nav-link ${panel === null ? 'nav-active' : ''}`}
            onClick={() => {
              setPanel(null);
              setMobileMenu(false);
            }}
          >
            <Icon name="board" />
            Play
          </button>
          <button
            className="nav-link"
            onClick={() => {
              setPanel('rules');
              setMobileMenu(false);
            }}
          >
            <Icon name="help" />
            How to play
          </button>
          <div className="sidebar-separator" />
          <p className="nav-group-label">Make it yours</p>
          <button
            className="nav-link"
            onClick={() => {
              setPanel('appearance');
              setMobileMenu(false);
            }}
          >
            <Icon name="settings" />
            Board & sound
          </button>
          <div className="sidebar-note">
            <span className="small-mark" aria-hidden="true">
              楚河 漢界
            </span>
            <p>
              Same river.
              <br />
              Your next move.
            </p>
          </div>
        </div>
        <div className="sidebar-footer">
          <span className="connection-dot" />
          <span>Two friends. One board.</span>
        </div>
        {mobileMenu && (
          <button
            className="mobile-close icon-button"
            aria-label="Close navigation"
            onClick={() => setMobileMenu(false)}
          >
            <Icon name="close" />
          </button>
        )}
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              onClick={() => setMobileMenu(true)}
            >
              <Icon name="menu" />
            </button>
            <Icon name="board" />
            <span>
              <span className="desktop-context">Private tables</span>
              <span className="mobile-context">Xiangqi</span>
            </span>
            <Icon name="chevron" size={14} />
            <span>{snapshot ? snapshot.code : 'Local board'}</span>
          </div>
          <div className="topbar-actions">
            <span className={`connection-label ${room.connection === 'offline' ? 'offline' : ''}`}>
              <i />
              {room.connection === 'local'
                ? 'No account needed'
                : room.connection === 'live'
                  ? 'Live connection'
                  : room.connection === 'offline'
                    ? 'Reconnecting…'
                    : room.connection === 'connecting'
                      ? 'Connecting…'
                      : 'Connected · polling'}
            </span>
            <button
              className="icon-button"
              aria-label={preferences.muted ? 'Unmute sound' : 'Mute sound'}
              onClick={() => {
                void enableSound();
                changePreference('muted', !preferences.muted);
              }}
            >
              <Icon name={preferences.muted ? 'muted' : 'sound'} />
            </button>
          </div>
        </header>
        <main className="workspace">
          <div className="page-heading">
            <div>
              <h1>{snapshot ? 'Your private table' : 'A table for two'}</h1>
              <p>
                {snapshot
                  ? `${clockDescription(snapshot.settings)} · ${snapshot.settings.allowUndo ? 'Takebacks by agreement' : 'No takebacks'}`
                  : 'Chinese chess. Good company. Your next move.'}
              </p>
            </div>
            {snapshot ? (
              <button className="button button-quiet" onClick={() => setConfirmation('leave')}>
                <Icon name="back" />
                Leave room
              </button>
            ) : (
              <button
                className="local-chip"
                onClick={() => document.getElementById('guest-name')?.focus()}
              >
                Play online
                <Icon name="arrow" size={14} />
              </button>
            )}
          </div>
          {!snapshot && returnNotice && (
            <div className="return-notice" role="status" data-testid="return-notice">
              <div>
                <strong>{returnNotice.title}</strong>
                <p>{returnNotice.description}</p>
              </div>
              <button
                className="icon-button"
                aria-label="Dismiss result"
                onClick={() => setReturnNotice(null)}
              >
                <Icon name="close" />
              </button>
            </div>
          )}
          {room.error && !room.invitation && (
            <div className="error-notice" role="alert">
              <span>{room.error}</span>
              <button className="text-button" onClick={() => room.setError('')}>
                Dismiss
              </button>
            </div>
          )}
          <div className="game-layout">
            <section className="table-section" aria-label="Game table">
              {player(topSide)}
              <div className="board-stage">
                <Board
                  key={snapshot ? `${snapshot.code}:${snapshot.gameId}` : `local:${boardResetId}`}
                  game={game}
                  flipped={displayFlipped}
                  canMove={canMove}
                  onMove={(from, to) => void move(from, to)}
                  pieceStyle={preferences.pieceStyle}
                  colorblind={preferences.colorblind}
                  theme={preferences.theme}
                />
              </div>
              {player(bottomSide)}
              <div className="board-toolbar">
                <button className="text-button" onClick={() => setFlipped(!flipped)}>
                  <Icon name="flip" size={16} />
                  Flip board
                </button>
                <span>WXF-based, simplified chase rule</span>
                <button
                  className="icon-button"
                  aria-label="Board appearance"
                  onClick={() => setPanel('appearance')}
                >
                  <Icon name="settings" size={16} />
                </button>
              </div>
              <p className="table-announcement" role="status" aria-live="polite">
                {announcement}
              </p>
            </section>
            <aside className="game-rail">
              {!snapshot ? (
                <section className="panel friend-panel">
                  <div className="panel-heading">
                    <h2>Play with a friend</h2>
                    <Icon name="link" />
                  </div>
                  <p className="panel-description">
                    A private room, an invite link,
                    <br className="desktop-break" /> and a little friendly rivalry.
                  </p>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void room.enter(name);
                    }}
                  >
                    <label htmlFor="guest-name">Your name</label>
                    <input
                      id="guest-name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      maxLength={20}
                      placeholder="What should we call you?"
                      autoComplete="nickname"
                      required
                    />
                    <button
                      type="submit"
                      className="button button-primary full-width"
                      disabled={room.busy || !name.trim()}
                    >
                      {room.busy ? 'Opening your table…' : 'Create a private room'}
                      <Icon name="arrow" size={17} />
                    </button>
                  </form>
                  <div className="join-divider">
                    <span>Have an invitation?</span>
                  </div>
                  <form
                    className="join-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void room.enter(name, room.inviteCode);
                    }}
                  >
                    <label htmlFor="room-code">Room code</label>
                    <div className="join-input">
                      <input
                        id="room-code"
                        value={room.inviteCode}
                        onChange={(event) => room.setInviteCode(event.target.value.toUpperCase())}
                        placeholder="Enter a room code"
                        autoComplete="off"
                        maxLength={16}
                        required
                      />
                      <button
                        className="button button-secondary"
                        type="submit"
                        disabled={room.busy || !name.trim() || !room.inviteCode.trim()}
                      >
                        Join room
                      </button>
                    </div>
                  </form>
                  <p className="small-note">No sign-up. Just send the link.</p>
                </section>
              ) : (
                <section className="panel room-panel">
                  <div className="panel-heading">
                    <h2>The room</h2>
                    <span className="room-code" data-testid="room-code">
                      {snapshot.code}
                    </span>
                  </div>
                  <button
                    className="button button-secondary full-width"
                    onClick={() => void copyInvite()}
                  >
                    <Icon name={copied ? 'check' : 'copy'} />
                    {copied ? 'Link copied' : 'Copy invite link'}
                  </button>
                  <label className="sr-only" htmlFor="invite-link">
                    Invite link
                  </label>
                  <input
                    className="invite-link"
                    id="invite-link"
                    readOnly
                    value={
                      typeof window !== 'undefined'
                        ? `${window.location.origin}/?room=${snapshot.code}`
                        : ''
                    }
                    onFocus={(event) => event.target.select()}
                  />
                  {activeStatus === 'waiting' && (
                    <>
                      <div className="seat-list">
                        {(['red', 'black'] as Color[]).map((side) => (
                          <div key={side}>
                            <span className={`side-dot ${side}`} />
                            <span>
                              {snapshot.seats[side]?.displayName ?? 'Waiting for a friend'}
                            </span>
                            <span className="seat-ready">
                              {snapshot.seats[side]?.ready
                                ? 'Ready'
                                : snapshot.seats[side]
                                  ? 'Not ready'
                                  : 'Open'}
                            </span>
                          </div>
                        ))}
                      </div>
                      <SettingsForm
                        value={settingsDraft}
                        onChange={setSettingsDraft}
                        disabled={!snapshot.you.isHost || room.busy}
                        onSave={() => void room.action('settings', settingsDraft)}
                      />
                      <button
                        className="button button-primary full-width ready-button"
                        disabled={room.busy || !opponent}
                        onClick={() => {
                          void enableSound();
                          void room.action('ready', {
                            ready: !snapshot.seats[snapshot.you.color]?.ready,
                          });
                        }}
                      >
                        <Icon name="check" />
                        {snapshot.seats[snapshot.you.color]?.ready ? 'Unready' : 'Ready to play'}
                      </button>
                      <p className="small-note">
                        {opponent
                          ? 'Both players must be ready.'
                          : 'Share the link to fill the other seat.'}
                      </p>
                    </>
                  )}
                  {snapshot.storage === 'local' && (
                    <p className="environment-note">
                      Local preview · rooms are saved on this computer.
                    </p>
                  )}
                  {snapshot.storage === 'redis' && !snapshot.schedulingAvailable && (
                    <p className="environment-note">
                      Timed games need the scheduler in production. Untimed games are available.
                    </p>
                  )}
                </section>
              )}
              <section className={`panel match-panel ${checked && !result ? 'in-check' : ''}`}>
                <div className="match-status">
                  <span className={`turn-marker ${game.turn}`} />
                  <h2>{statusTitle}</h2>
                  {checked && activeStatus === 'playing' && !result && (
                    <span className="check-label">Check</span>
                  )}
                </div>
                <p>
                  {result
                    ? result.reason.replaceAll('-', ' ')
                    : activeStatus === 'waiting'
                      ? 'Set the pace. Invite your opponent.'
                      : activeStatus === 'aborted'
                        ? 'Ready for another? Request a rematch below.'
                        : snapshot
                          ? snapshot.you.color === game.turn
                            ? 'Your move. Take a breath.'
                            : 'Your opponent is thinking.'
                          : 'Try a move, or invite a friend to play online.'}
                </p>
                {snapshot && activeStatus === 'playing' && (
                  <>
                    <div className="match-actions">
                      <button
                        className="button button-quiet"
                        disabled={room.busy || !!draw}
                        onClick={() => void room.action('draw', { action: 'offer' })}
                      >
                        <Icon name="draw" />
                        Offer draw
                      </button>
                      <button
                        className="button button-quiet"
                        disabled={room.busy}
                        onClick={() => setConfirmation('resign')}
                      >
                        <Icon name="flag" />
                        Resign
                      </button>
                      {snapshot.settings.allowUndo && (
                        <button
                          className="button button-quiet"
                          disabled={room.busy || !game.moves.length || !!undo}
                          onClick={() => void room.action('undo', { action: 'offer' })}
                        >
                          <Icon name="undo" />
                          Takeback
                        </button>
                      )}
                    </div>
                    {game.moves.length === 0 &&
                      snapshot.abortUntil !== null &&
                      serverNow <= snapshot.abortUntil && (
                        <button
                          className="text-button subtle"
                          onClick={() => void room.action('abort')}
                        >
                          Cancel before the first move
                        </button>
                      )}
                  </>
                )}
                {draw && (
                  <div className="offer-notice">
                    <p>
                      {draw.by === snapshot?.you.color
                        ? 'You offered a draw.'
                        : 'Your opponent offered a draw.'}
                    </p>
                    {draw.by !== snapshot?.you.color ? (
                      <div className="offer-actions">
                        <button
                          className="button button-secondary"
                          disabled={room.busy}
                          onClick={() => void room.action('draw', { action: 'accept' })}
                        >
                          Accept draw
                        </button>
                        <button
                          className="text-button"
                          onClick={() => void room.action('draw', { action: 'decline' })}
                        >
                          Decline
                        </button>
                      </div>
                    ) : (
                      <span>Waiting for an answer.</span>
                    )}
                  </div>
                )}
                {undo && (
                  <div className="offer-notice">
                    <p>
                      {undo.by === snapshot?.you.color
                        ? 'Takeback requested.'
                        : 'Your opponent requested a takeback.'}
                    </p>
                    {undo.by !== snapshot?.you.color && (
                      <div className="offer-actions">
                        <button
                          className="button button-secondary"
                          disabled={room.busy}
                          onClick={() => void room.action('undo', { action: 'accept' })}
                        >
                          Accept takeback
                        </button>
                        <button
                          className="text-button"
                          onClick={() => void room.action('undo', { action: 'decline' })}
                        >
                          Decline
                        </button>
                      </div>
                    )}
                  </div>
                )}
                {opponent && !opponent.connected && activeStatus === 'playing' && (
                  <div className="offer-notice">
                    <p>Opponent disconnected. Their clock keeps running.</p>
                    <span>
                      {disconnectSeconds > 0
                        ? `They have ${disconnectSeconds}s to return before an automatic loss.`
                        : 'Finalizing the result…'}
                    </span>
                  </div>
                )}
                {snapshot &&
                  !forfeitedGameId &&
                  (activeStatus === 'finished' || activeStatus === 'aborted') && (
                    <button
                      className="button button-primary full-width"
                      disabled={
                        room.busy || snapshot.pendingOffers.rematch.includes(snapshot.you.color)
                      }
                      onClick={() =>
                        void room.action('rematch', {
                          action: snapshot.pendingOffers.rematch.length ? 'accept' : 'request',
                        })
                      }
                    >
                      <Icon name="refresh" />
                      {snapshot.pendingOffers.rematch.includes(snapshot.you.color)
                        ? 'Waiting for rematch…'
                        : snapshot.pendingOffers.rematch.length
                          ? 'Accept rematch'
                          : 'Request rematch'}
                    </button>
                  )}
                {!snapshot && (
                  <button className="text-button" onClick={() => setConfirmation('reset')}>
                    <Icon name="refresh" size={16} />
                    New local game
                  </button>
                )}
              </section>
              <section className="panel moves-panel">
                <div className="panel-heading">
                  <h2>Moves</h2>
                  <span className="muted">
                    {game.moves.length ? `${game.moves.length} played` : 'A fresh board'}
                  </span>
                </div>
                <div className="move-columns" aria-hidden="true">
                  <span>Move</span>
                  <span>Red</span>
                  <span>Black</span>
                </div>
                <div className="move-list" aria-label="Move list" ref={lastMoveElement}>
                  {game.moves.length ? (
                    Array.from({ length: Math.ceil(game.moves.length / 2) }, (_, index) => (
                      <div className="move-row" key={index}>
                        <span>{index + 1}.</span>
                        <span
                          className={game.moves.length - 1 === index * 2 ? 'latest-notation' : ''}
                        >
                          {game.moves[index * 2]?.notation ?? '—'}
                        </span>
                        <span
                          className={
                            game.moves.length - 1 === index * 2 + 1 ? 'latest-notation' : ''
                          }
                        >
                          {game.moves[index * 2 + 1]?.notation ?? '—'}
                        </span>
                      </div>
                    ))
                  ) : (
                    <div className="empty-moves">
                      <span className="empty-board-mark" aria-hidden="true">
                        兵
                      </span>
                      <p>
                        Every game starts
                        <br />
                        with a possibility.
                      </p>
                    </div>
                  )}
                </div>
              </section>
            </aside>
          </div>
          <footer className="workspace-footer">
            <span>
              <span className="footer-mark" aria-hidden="true">
                象
              </span>
              Made for the love of the game.
            </span>
            <button className="text-button" onClick={() => setPanel('rules')}>
              The rules of the river
              <Icon name="arrow" size={15} />
            </button>
          </footer>
        </main>
      </div>
      {room.invitation && (
        <Modal
          title="Join room"
          onClose={() => {
            if (!room.busy) room.leave(false);
          }}
        >
          <p className="modal-description">A friend has invited you to the table.</p>
          {room.inviteLoading && (
            <p className="invite-loading" role="status">
              Opening your invitation…
            </p>
          )}
          {room.invitePreview && (
            <div className="invite-opponent">
              <div
                className={`player-avatar ${room.invitePreview.opponent.color}`}
                aria-hidden="true"
              >
                {room.invitePreview.opponent.color === 'red' ? '帥' : '將'}
              </div>
              <div>
                <strong>{room.invitePreview.opponent.displayName}</strong>
                <p>
                  {sideName(room.invitePreview.opponent.color)} ·{' '}
                  {clockDescription(room.invitePreview.settings)}
                </p>
              </div>
              <span className="invite-seat-label">Your opponent</span>
            </div>
          )}
          {(room.inviteError || room.error) && (
            <p className="invite-error" role="alert">
              {room.inviteError || room.error}
            </p>
          )}
          {room.invitePreview && !room.invitePreview.canJoin && (
            <p className="invite-error" role="status">
              {room.invitePreview.status === 'waiting'
                ? 'Both seats are taken. Ask your friend for a fresh invitation.'
                : 'This game has already started. Ask your friend for a new room.'}
            </p>
          )}
          <form
            className="invite-form"
            onSubmit={(event) => {
              event.preventDefault();
              void enableSound();
              void room.enter(name, room.invitation!);
            }}
          >
            <label htmlFor="invite-name">Your name</label>
            <input
              id="invite-name"
              autoFocus
              autoComplete="nickname"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={20}
              placeholder="What should we call you?"
              disabled={room.busy}
              required
            />
            <button
              className="button button-primary full-width"
              type="submit"
              disabled={room.busy || !name.trim() || !room.invitePreview?.canJoin}
            >
              {room.busy ? 'Joining the table…' : 'Join room'}
              <Icon name="arrow" size={17} />
            </button>
          </form>
          <p className="small-note">
            {room.invitePreview?.canJoin
              ? 'Choose a name, take your seat, and get ready to play.'
              : 'You can close this invitation to return to your local board.'}
          </p>
        </Modal>
      )}
      {snapshot && !soundUnlocked && !preferences.muted && (
        <button className="sound-prompt button button-secondary" onClick={() => void enableSound()}>
          <Icon name="sound" />
          Tap to enable sound
        </button>
      )}
      {panel && (
        <Modal
          title={panel === 'appearance' ? 'Board & sound' : 'The rules of the river'}
          onClose={() => setPanel(null)}
        >
          {panel === 'appearance' ? (
            <div className="preferences">
              <p className="modal-description">
                Your side of the table. These choices stay on this device.
              </p>
              <fieldset>
                <legend>Board theme</legend>
                <div className="theme-options">
                  {(['ink', 'jade', 'paper'] as const).map((theme) => (
                    <button
                      key={theme}
                      className={`theme-option theme-${theme} ${preferences.theme === theme ? 'chosen' : ''}`}
                      aria-pressed={preferences.theme === theme}
                      onClick={() => changePreference('theme', theme)}
                    >
                      <span className="theme-preview">
                        <span>兵</span>
                        <span>將</span>
                      </span>
                      {theme === 'ink' ? 'Ink' : theme === 'jade' ? 'Jade' : 'Paper'}
                      {preferences.theme === theme && <Icon name="check" size={14} />}
                    </button>
                  ))}
                </div>
              </fieldset>
              <label className="field-label" htmlFor="piece-style">
                Piece faces
              </label>
              <select
                id="piece-style"
                value={preferences.pieceStyle}
                onChange={(event) =>
                  changePreference('pieceStyle', event.target.value as Preferences['pieceStyle'])
                }
              >
                <option value="characters">Traditional characters</option>
                <option value="symbols">Letters · G A E H R C S</option>
              </select>
              <label className="switch-row">
                <span>
                  Colorblind-friendly pieces
                  <small>Blue Red pieces and double-ring Black pieces.</small>
                </span>
                <input
                  type="checkbox"
                  checked={preferences.colorblind}
                  onChange={(event) => changePreference('colorblind', event.target.checked)}
                />
              </label>
              <div className="preference-divider" />
              <label className="switch-row">
                <span>
                  Sound<small>Short notes for moves and captures.</small>
                </span>
                <input
                  type="checkbox"
                  checked={!preferences.muted}
                  onChange={(event) => {
                    void enableSound();
                    changePreference('muted', !event.target.checked);
                  }}
                />
              </label>
              <label className="field-label" htmlFor="volume">
                Volume <span>{Math.round(preferences.volume * 100)}%</span>
              </label>
              <input
                id="volume"
                type="range"
                min="0"
                max="1"
                step=".05"
                value={preferences.volume}
                onChange={(event) => {
                  void enableSound();
                  changePreference('volume', Number(event.target.value));
                }}
              />
              <label className="switch-row">
                <span>
                  Alert sounds<small>Check, your turn, low time, and connection changes.</small>
                </span>
                <input
                  type="checkbox"
                  checked={preferences.alerts}
                  onChange={(event) => changePreference('alerts', event.target.checked)}
                />
              </label>
              <p className="small-note">
                Every sound has a visual cue. Audio needs a tap after refreshing.
              </p>
            </div>
          ) : (
            <Rules />
          )}
        </Modal>
      )}
      {confirmation && (
        <Modal
          title={
            confirmation === 'resign'
              ? 'Resign this game?'
              : confirmation === 'leave'
                ? 'Leave this table?'
                : 'Start a fresh board?'
          }
          onClose={() => setConfirmation(null)}
        >
          <p className="modal-description">
            {confirmation === 'resign'
              ? 'Your opponent will win this game. You can still play a rematch.'
              : confirmation === 'leave'
                ? 'Your seat stays saved on this device. During a game, leaving for 30 seconds forfeits the match.'
                : `${game.moves.length ? `Your ${game.moves.length} local moves will be cleared.` : 'The pieces will return to their starting positions.'}`}
          </p>
          <div className="confirmation-actions">
            <button className="button button-secondary" onClick={() => setConfirmation(null)}>
              Keep playing
            </button>
            <button
              className="button button-primary"
              onClick={() => {
                if (confirmation === 'resign') void room.action('resign');
                else if (confirmation === 'leave') returnHome();
                else {
                  setReturnNotice(null);
                  resetLocalBoard();
                }
                setConfirmation(null);
              }}
            >
              {confirmation === 'resign'
                ? 'Resign game'
                : confirmation === 'leave'
                  ? 'Leave table'
                  : 'Start new game'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function SettingsForm({
  value,
  onChange,
  disabled,
  onSave,
}: {
  value: RoomSettings;
  onChange: (settings: RoomSettings) => void;
  disabled: boolean;
  onSave: () => void;
}) {
  function field<K extends keyof RoomSettings>(key: K, next: RoomSettings[K]) {
    onChange({ ...value, [key]: next });
  }
  return (
    <form
      className="room-settings"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <div className="settings-title">
        <h3>Match settings</h3>
        {disabled && <span>Host chooses</span>}
      </div>
      <label htmlFor="clock-mode">Clock mode</label>
      <select
        id="clock-mode"
        value={value.clockMode}
        disabled={disabled}
        onChange={(event) => field('clockMode', event.target.value as RoomSettings['clockMode'])}
      >
        <option value="untimed">Untimed</option>
        <option value="increment">Increment</option>
        <option value="per-move">Per-move</option>
      </select>
      {value.clockMode === 'increment' && (
        <div className="field-pair">
          <div>
            <label htmlFor="main-time">Minutes</label>
            <input
              id="main-time"
              type="number"
              min="1"
              max="120"
              value={value.mainTimeMs / 60000}
              disabled={disabled}
              onChange={(event) => field('mainTimeMs', Number(event.target.value) * 60000)}
            />
          </div>
          <div>
            <label htmlFor="increment">Increment (s)</label>
            <input
              id="increment"
              type="number"
              min="0"
              max="60"
              value={value.incrementMs / 1000}
              disabled={disabled}
              onChange={(event) => field('incrementMs', Number(event.target.value) * 1000)}
            />
          </div>
        </div>
      )}
      {value.clockMode === 'per-move' && (
        <>
          <label htmlFor="per-move">Seconds per move</label>
          <input
            id="per-move"
            type="number"
            min="10"
            max="600"
            value={value.perMoveMs / 1000}
            disabled={disabled}
            onChange={(event) => field('perMoveMs', Number(event.target.value) * 1000)}
          />
        </>
      )}
      <label htmlFor="host-side">Host plays</label>
      <select
        id="host-side"
        value={value.hostSide}
        disabled={disabled}
        onChange={(event) => field('hostSide', event.target.value as RoomSettings['hostSide'])}
      >
        <option value="red">Red · moves first</option>
        <option value="black">Black</option>
        <option value="random">Random side</option>
      </select>
      <label className="compact-switch">
        <span>Allow takebacks by agreement</span>
        <input
          type="checkbox"
          checked={value.allowUndo}
          disabled={disabled}
          onChange={(event) => field('allowUndo', event.target.checked)}
        />
      </label>
      {!disabled && (
        <button className="button button-secondary full-width" type="submit">
          Save match settings
        </button>
      )}
    </form>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      className="modal"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal-inner">
        <div className="modal-title">
          <h2>{title}</h2>
          <button className="icon-button" aria-label="Close dialog" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

function Rules() {
  return (
    <div className="rules-content">
      <p className="modal-description">Nine files. Ten ranks. One river between two armies.</p>
      <h3>The goal</h3>
      <p>
        Trap your opponent’s general so they have no legal move. In Xiangqi, both checkmate and
        stalemate are a loss for the player who cannot move. Red moves first.
      </p>
      <dl className="piece-guide">
        <dt>General · 帥 / 將</dt>
        <dd>
          One step straight inside the palace. The generals may never face one another on an open
          file.
        </dd>
        <dt>Advisor · 仕 / 士</dt>
        <dd>One step diagonally inside the palace.</dd>
        <dt>Elephant · 相 / 象</dt>
        <dd>
          Two steps diagonally. A blocked eye stops the move. Elephants stay on their own side of
          the river.
        </dd>
        <dt>Horse · 傌 / 馬</dt>
        <dd>
          One step straight, then one diagonal. A piece at the first step blocks the horse’s leg.
        </dd>
        <dt>Rook · 俥 / 車</dt>
        <dd>Any clear distance along a rank or file.</dd>
        <dt>Cannon · 炮 / 砲</dt>
        <dd>Moves like a rook. To capture, it must jump exactly one piece.</dd>
        <dt>Soldier · 兵 / 卒</dt>
        <dd>
          One step forward. After crossing the river, it may also move one step sideways. Never
          backward.
        </dd>
      </dl>
      <h3>At this table</h3>
      <p>
        WXF-based, simplified chase rule. The WXF 2018 rules are the reference. Perpetual check
        loses; a repeated position without a single checking offender is drawn. Full perpetual-chase
        adjudication is deferred.
      </p>
      <p>
        The no-capture draw count is 100 counted half-moves, with excess checking moves excluded.
        The online arbiter applies repetitions automatically after four occurrences.
      </p>
      <h3>Clocks & connection</h3>
      <p>
        The server keeps time, even during a disconnect. Increment is skipped on each player’s first
        move. Before any move, either player can cancel during the first 30 seconds. A disconnect
        loss is automatic after 30 seconds away while the other player remains connected. Return
        before the deadline to continue. When both players are away, neither wins by absence alone.
      </p>
      <h3>Keyboard play</h3>
      <p>
        Tab to the board. Use the arrow keys to choose a square, Enter or Space to select and move,
        and Escape to clear your selection.
      </p>
    </div>
  );
}
