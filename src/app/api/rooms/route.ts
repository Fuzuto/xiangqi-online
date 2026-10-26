import { api, jsonBody, requestIp, service } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return api(request, async () => service().create(await jsonBody(request), requestIp(request)));
}
