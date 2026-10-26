import { createHash } from 'node:crypto';
import type { InvitePreview } from '../invite-types';
import { RoomError } from './model';
import type { RoomStore } from './store';

export async function readInvite(
  store: RoomStore,
  value: string,
  ip: string,
  now = Date.now(),
): Promise<{ invite: InvitePreview }> {
  const code = value.toUpperCase();
  if (!/^[2-9A-HJ-NP-Z]{10}$/.test(code)) {
    throw new RoomError(
      'This room could not be found. Check the invitation code.',
      'ROOM_NOT_FOUND',
      404,
    );
  }

  const visitor = createHash('sha256').update(ip).digest('hex').slice(0, 24);
  const allowedIp = await store.rateLimit(`ip:${visitor}:invite`, 60, 60_000, now);
  if (!allowedIp || !(await store.rateLimit(`room:${code}:invite`, 120, 60_000, now))) {
    throw new RoomError(
      'Too many invitations were opened. Please wait a moment and retry.',
      'RATE_LIMITED',
      429,
    );
  }

  const room = await store.get(code);
  if (!room) {
    throw new RoomError(
      'This room could not be found. Check the invitation code.',
      'ROOM_NOT_FOUND',
      404,
    );
  }
  if (room.expiresAt <= now) {
    throw new RoomError(
      'This room has expired. Ask your friend for a new invitation.',
      'ROOM_EXPIRED',
      410,
    );
  }

  const hostColor = room.seats.red?.id === room.hostId ? 'red' : 'black';
  const host = room.seats[hostColor];
  if (!host || host.id !== room.hostId) {
    throw new RoomError(
      'This invitation is temporarily unavailable. Please retry.',
      'STORAGE_UNAVAILABLE',
      503,
    );
  }

  return {
    invite: {
      code: room.code,
      opponent: { displayName: host.displayName, color: hostColor },
      settings: {
        clockMode: room.settings.clockMode,
        mainTimeMs: room.settings.mainTimeMs,
        incrementMs: room.settings.incrementMs,
        perMoveMs: room.settings.perMoveMs,
        hostSide: room.settings.hostSide,
        allowUndo: room.settings.allowUndo,
      },
      status: room.status,
      canJoin: room.status === 'waiting' && (!room.seats.red || !room.seats.black),
    },
  };
}
