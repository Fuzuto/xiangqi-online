import { upgradeWebSocket } from '@vercel/functions';
import { z } from 'zod';
import { api, checkOrigin, requestIp, service } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: Request, context: { params: Promise<{ code: string }> }) {
  try {
    checkOrigin(request);
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return Response.json(
        { error: 'Use the WebSocket transport for this endpoint.' },
        { status: 426 },
      );
    }
    const { code } = await context.params;
    const rooms = service();
    return await upgradeWebSocket(
      (socket) => {
        let token = '';
        let authenticated = false;
        let authenticating = false;
        let closed = false;
        let lastId = '0-0';
        let version = -1;
        let heartbeat = 0;
        const authDeadline = setTimeout(() => socket.close(1008, 'Authentication required'), 5_000);
        const end = () => {
          closed = true;
          clearTimeout(authDeadline);
        };
        socket.on('close', end);
        socket.on('error', end);
        socket.on('message', async (message) => {
          if (authenticated || authenticating || closed) return;
          authenticating = true;
          try {
            const parsed = z
              .object({ token: z.string().min(1).max(200) })
              .strict()
              .parse(JSON.parse(message.toString()));
            token = parsed.token;
            const response = await rooms.read(code, token, requestIp(request));
            authenticated = true;
            clearTimeout(authDeadline);
            version = response.snapshot.version;
            heartbeat = Date.now();
            socket.send(JSON.stringify(response));
            while (!closed && socket.readyState === socket.OPEN) {
              const update = await rooms.store.updates(code, lastId);
              if (update) lastId = update.id;
              const now = Date.now();
              if ((update && update.version > version) || now - heartbeat >= 6_000) {
                const touch = now - heartbeat >= 6_000;
                const next = await rooms.read(code, token, requestIp(request), false, touch);
                if (touch) heartbeat = now;
                version = next.snapshot.version;
                socket.send(JSON.stringify(next));
              }
              await new Promise((done) => setTimeout(done, 800));
            }
          } catch {
            socket.close(
              1008,
              authenticated ? 'Reconnect to restore the room' : 'Authentication failed',
            );
          }
        });
      },
      { maxPayload: 512 },
    );
  } catch {
    // Next's own dev server cannot upgrade; the client automatically uses HTTP polling there.
    return api(request, async () => {
      throw new Error('WebSocket transport unavailable');
    });
  }
}
