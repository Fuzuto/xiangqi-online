import { api, requestIp } from '@/lib/server/http';
import { readInvite } from '@/lib/server/invite';
import { getStore } from '@/lib/server/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ code: string }> }) {
  return api(request, async () =>
    readInvite(getStore(), (await context.params).code, requestIp(request)),
  );
}
