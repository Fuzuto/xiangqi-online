import { z } from 'zod';
import { api, jsonBody, service } from '@/lib/server/http';
import { RoomError } from '@/lib/server/model';
import { secretsEqual } from '@/lib/server/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return api(request, async () => {
    if (
      process.env.E2E_TEST_MODE !== '1' ||
      process.env.VERCEL ||
      !process.env.E2E_TEST_SECRET ||
      !secretsEqual(request.headers.get('x-test-secret') ?? '', process.env.E2E_TEST_SECRET)
    ) {
      throw new RoomError('Not found.', 'NOT_FOUND', 404);
    }
    const { code, scenario } = z
      .object({ code: z.string(), scenario: z.enum(['stalemate', 'timeout']) })
      .strict()
      .parse(await jsonBody(request));
    return service().installTestScenario(code, scenario);
  });
}
