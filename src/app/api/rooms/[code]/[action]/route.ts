import { z } from 'zod';
import { api, jsonBody, requestIp, requestToken, service } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const actionSchema = z.enum([
  'settings',
  'ready',
  'move',
  'resign',
  'draw',
  'undo',
  'rematch',
  'abort',
  'claim',
  'leave',
]);

export async function POST(
  request: Request,
  context: { params: Promise<{ code: string; action: string }> },
) {
  return api(request, async () => {
    const { code, action } = await context.params;
    const body = await jsonBody(request);
    if (action === 'join')
      return service().join(code, body, requestToken(request) || undefined, requestIp(request));
    return service().action(
      code,
      actionSchema.parse(action),
      body,
      requestToken(request),
      requestIp(request),
    );
  });
}
