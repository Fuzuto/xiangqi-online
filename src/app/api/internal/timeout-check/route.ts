import { z } from 'zod';
import { api, jsonBody, requestToken, service } from '@/lib/server/http';
import { RoomError } from '@/lib/server/model';
import { secretsEqual } from '@/lib/server/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return api(request, async () => {
    const secret = process.env.TIMEOUT_SECRET;
    if (!secret || !secretsEqual(requestToken(request), secret))
      throw new RoomError('Access denied.', 'UNAUTHORIZED', 401);
    const { code } = z
      .object({ code: z.string() })
      .strict()
      .parse(await jsonBody(request));
    return service().checkTimeout(code);
  });
}
