import { z } from 'zod';
import { RoomError } from './model';
import { RoomService } from './service';
import { getStore } from './store';

export function service() {
  return new RoomService(getStore());
}

export function requestToken(request: Request) {
  const header = request.headers.get('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

export function requestIp(request: Request) {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
}

export function checkOrigin(request: Request) {
  const origin = request.headers.get('origin');
  const url = new URL(request.url);
  const protocol =
    request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ??
    url.protocol.replace(':', '');
  // Next may use localhost internally even when a phone or browser reaches a LAN/127.0.0.1 host.
  const host = request.headers.get('host') ?? url.host;
  const expected = `${protocol}://${host}`;
  if (origin && origin !== expected) {
    throw new RoomError('This request did not come from the game.', 'INVALID_ORIGIN', 403);
  }
}

export async function jsonBody(request: Request) {
  if (!request.headers.get('content-type')?.includes('application/json')) {
    throw new RoomError('Send a JSON request.', 'INVALID_INPUT');
  }
  if (Number(request.headers.get('content-length') ?? 0) > 8_192)
    throw new RoomError('This request is too large.', 'INVALID_INPUT', 413);
  const body = await request.text();
  if (Buffer.byteLength(body) > 8_192)
    throw new RoomError('This request is too large.', 'INVALID_INPUT', 413);
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new RoomError('This request could not be read. Please retry.', 'INVALID_INPUT');
  }
}

export async function api(request: Request, action: () => Promise<unknown>) {
  try {
    checkOrigin(request);
    return Response.json(await action(), { headers: { 'Cache-Control': 'no-store, private' } });
  } catch (error) {
    if (error instanceof RoomError)
      return Response.json({ error: error.message, code: error.code }, { status: error.status });
    if (error instanceof z.ZodError)
      return Response.json(
        { error: 'Please check the guest name and match settings.', code: 'INVALID_INPUT' },
        { status: 400 },
      );
    return Response.json(
      {
        error: 'The game service is temporarily unavailable. Please retry.',
        code: 'SERVICE_UNAVAILABLE',
      },
      { status: 503 },
    );
  }
}
