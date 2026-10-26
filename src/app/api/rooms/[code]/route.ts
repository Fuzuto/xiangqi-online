import { api, requestIp, requestToken, service } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ code: string }> }) {
  return api(request, async () =>
    service().read((await context.params).code, requestToken(request), requestIp(request)),
  );
}
