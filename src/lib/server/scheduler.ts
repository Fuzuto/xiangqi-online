import type { RoomRecord } from './model';
import { RoomError } from './model';

export function timeoutDeadline(room: RoomRecord) {
  return room.status === 'playing' &&
    room.settings.clockMode !== 'untimed' &&
    room.clocks.turnStartedAt !== null &&
    room.clocks.turnRemainingMs !== null
    ? room.clocks.turnStartedAt + room.clocks.turnRemainingMs
    : null;
}

export function schedulingAvailable() {
  return Boolean(
    process.env.QSTASH_TOKEN && process.env.TIMEOUT_SECRET && process.env.APP_BASE_URL,
  );
}

export async function scheduleTimeout(room: RoomRecord) {
  const deadline = timeoutDeadline(room);
  if (deadline === null) return;
  if (!schedulingAvailable()) {
    const localE2E = process.env.E2E_TEST_MODE === '1' && !process.env.VERCEL;
    if (process.env.NODE_ENV === 'production' && !localE2E) {
      throw new RoomError(
        'Timed rooms need the timeout scheduler configured. Choose untimed for now.',
        'SCHEDULER_NOT_CONFIGURED',
        503,
      );
    }
    return;
  }
  const base = process.env.APP_BASE_URL!;
  if (!base.startsWith('https://') && !base.startsWith('http://localhost:')) {
    throw new RoomError(
      'The timeout callback address is not configured correctly.',
      'SCHEDULER_NOT_CONFIGURED',
      503,
    );
  }
  const callback = `${base.replace(/\/$/, '')}/api/internal/timeout-check`;
  try {
    const response = await fetch(
      `${process.env.QSTASH_URL ?? 'https://qstash.upstash.io'}/v2/publish/${callback}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.QSTASH_TOKEN}`,
          'Content-Type': 'application/json',
          'Upstash-Not-Before': String(Math.ceil(deadline / 1_000)),
          'Upstash-Forward-Authorization': `Bearer ${process.env.TIMEOUT_SECRET}`,
          'Upstash-Retries': '3',
          'Upstash-Deduplication-Id': `xiangqi-${room.code}-${room.version}-${deadline}`,
        },
        body: JSON.stringify({ code: room.code }),
        signal: AbortSignal.timeout(7_000),
      },
    );
    if (!response.ok) throw new Error('Scheduler unavailable');
  } catch {
    throw new RoomError(
      'The clock scheduler is temporarily unavailable. Please retry your action.',
      'SCHEDULER_UNAVAILABLE',
      503,
    );
  }
}
