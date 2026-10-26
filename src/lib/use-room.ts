'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RoomAction, RoomResponse, RoomSnapshot } from './server/types';

export function useRoom() {
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [code, setCode] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [connection, setConnection] = useState<
    'local' | 'connecting' | 'live' | 'polling' | 'offline'
  >('local');
  const [clockOffset, setClockOffset] = useState(0);
  const tokenRef = useRef('');
  const activeCode = useRef('');
  const accept = useCallback((next: RoomSnapshot, started = Date.now()) => {
    setClockOffset(next.serverNow - (started + Date.now()) / 2);
    setSnapshot((previous) =>
      previous && previous.code === next.code && previous.version > next.version ? previous : next,
    );
  }, []);
  useEffect(() => {
    const requested = (new URLSearchParams(window.location.search).get('room') ?? '').toUpperCase();
    if (!requested) return;
    setInviteCode(requested);
    try {
      const token = localStorage.getItem(`xiangqi-seat:${requested}`);
      if (token) {
        tokenRef.current = token;
        activeCode.current = requested;
        setCode(requested);
        setConnection('connecting');
      }
    } catch {
      setError('Enable browser storage to save and restore your seat.');
    }
  }, []);
  const request = useCallback(
    async (path: string, body?: unknown, token = tokenRef.current) => {
      const started = Date.now();
      const response = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        cache: 'no-store',
      });
      const result = (await response.json()) as RoomResponse & { error?: string };
      if (!response.ok)
        throw new Error(result.error ?? 'The room could not be reached. Please try again.');
      if (result.snapshot && result.snapshot.code === activeCode.current)
        accept(result.snapshot, started);
      return result;
    },
    [accept],
  );
  useEffect(() => {
    if (!code) return;
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let backoff = 1500;
    let lastVersion = 0;
    async function poll() {
      try {
        const result = await request(`/api/rooms/${encodeURIComponent(code)}`);
        if (disposed) return;
        lastVersion = result.snapshot.version;
        setError('');
        setConnection(socket?.readyState === WebSocket.OPEN ? 'live' : 'polling');
      } catch (error) {
        if (!disposed) {
          setError(error instanceof Error ? error.message : 'Connection lost. Retrying…');
          setConnection('offline');
        }
      }
    }
    function connect() {
      if (disposed) return;
      const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(
        `${scheme}//${window.location.host}/api/rooms/${encodeURIComponent(code)}/socket`,
      );
      socket.onopen = () => {
        socket?.send(JSON.stringify({ token: tokenRef.current }));
        backoff = 1500;
      };
      socket.onmessage = (event) => {
        if (disposed || activeCode.current !== code) return;
        try {
          const message = JSON.parse(event.data);
          if (message.snapshot && message.snapshot.code === activeCode.current) {
            accept(message.snapshot);
            lastVersion = message.snapshot.version;
            setConnection('live');
            setError('');
          } else if (message.version > lastVersion) void poll();
        } catch {
          /* A broken push frame is recovered by the next poll. */
        }
      };
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        if (disposed) return;
        setConnection((previous) => (previous === 'offline' ? 'offline' : 'polling'));
        reconnect = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30000);
      };
    }
    void poll();
    connect();
    const interval = setInterval(() => void poll(), 2000);
    const focused = () => void poll();
    window.addEventListener('focus', focused);
    return () => {
      disposed = true;
      clearInterval(interval);
      clearTimeout(reconnect);
      socket?.close();
      window.removeEventListener('focus', focused);
    };
  }, [code, request, accept]);
  async function enter(name: string, joinCode?: string) {
    setBusy(true);
    setError('');
    try {
      try {
        localStorage.setItem('xiangqi-storage-check', 'ok');
        localStorage.removeItem('xiangqi-storage-check');
      } catch {
        throw new Error('Enable browser storage before joining so your secret seat can be saved.');
      }
      const normalized = joinCode?.trim().toUpperCase();
      const token = normalized ? (localStorage.getItem(`xiangqi-seat:${normalized}`) ?? '') : '';
      const result = await request(
        normalized ? `/api/rooms/${encodeURIComponent(normalized)}/join` : '/api/rooms',
        { name },
        token,
      );
      const seatToken = result.token || token;
      localStorage.setItem(`xiangqi-seat:${result.snapshot.code}`, seatToken);
      localStorage.setItem('xiangqi-name', name.trim());
      tokenRef.current = seatToken;
      activeCode.current = result.snapshot.code;
      accept(result.snapshot);
      setCode(result.snapshot.code);
      setInviteCode(result.snapshot.code);
      setConnection('connecting');
      window.history.replaceState({}, '', `?room=${encodeURIComponent(result.snapshot.code)}`);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not open the room. Try again.');
    } finally {
      setBusy(false);
    }
  }
  async function action(action: RoomAction, body: unknown = {}) {
    if (!code || !snapshot) return;
    setBusy(true);
    setError('');
    const payload: Record<string, unknown> = {
      ...(body as Record<string, unknown>),
      gameId: snapshot.gameId,
      ...(action === 'move' ? { branchId: snapshot.branchId } : {}),
    };
    if ((action === 'draw' || action === 'undo') && payload.action !== 'offer')
      Object.assign(payload, { offerId: snapshot.pendingOffers[action]?.id });
    try {
      await request(`/api/rooms/${encodeURIComponent(code)}/${action}`, payload);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'That action could not be completed.');
    } finally {
      setBusy(false);
    }
  }
  function leave() {
    activeCode.current = '';
    setCode('');
    setSnapshot(null);
    setInviteCode('');
    setConnection('local');
    setError('');
    tokenRef.current = '';
    window.history.replaceState({}, '', '/');
  }
  return {
    snapshot,
    code,
    inviteCode,
    setInviteCode,
    error,
    setError,
    busy,
    connection,
    clockOffset,
    enter,
    action,
    leave,
  };
}
