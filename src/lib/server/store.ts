import { mkdir, readFile, rename, rmdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RoomRecord } from './model';
import { RoomError } from './model';

export interface RoomStore {
  kind: 'redis' | 'local';
  get(code: string): Promise<RoomRecord | null>;
  compareAndSet(code: string, version: number | null, next: RoomRecord): Promise<boolean>;
  rateLimit(key: string, limit: number, windowMs: number, now: number): Promise<boolean>;
  updates(code: string, after: string): Promise<{ id: string; version: number } | null>;
}

const CAS_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if ARGV[1] == 'new' then
  if current then return 0 end
else
  if not current or cjson.decode(current).version ~= tonumber(ARGV[1]) then return 0 end
end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
redis.call('ZADD', KEYS[2], ARGV[4], ARGV[5])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[7])
redis.call('XADD', KEYS[3], 'MAXLEN', '~', 100, '*', 'version', ARGV[6])
redis.call('PEXPIRE', KEYS[3], ARGV[3])
return 1`;

const RATE_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return count`;

export class RedisRoomStore implements RoomStore {
  kind = 'redis' as const;

  constructor(
    private url: string,
    private token: string,
  ) {}

  async command<T>(...args: (string | number)[]): Promise<T> {
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
        cache: 'no-store',
        signal: AbortSignal.timeout(7_000),
      });
      if (!response.ok) throw new Error('Storage unavailable');
      const data = (await response.json()) as { result: T; error?: string };
      if (data.error) throw new Error('Storage unavailable');
      return data.result;
    } catch {
      throw new RoomError(
        'The game service is temporarily unavailable. Please try again.',
        'STORAGE_UNAVAILABLE',
        503,
      );
    }
  }

  async get(code: string) {
    const value = await this.command<string | null>('GET', `xiangqi:room:${code}`);
    if (!value) return null;
    try {
      return JSON.parse(value) as RoomRecord;
    } catch {
      throw new RoomError(
        'This room could not be loaded safely. Please retry.',
        'STORAGE_UNAVAILABLE',
        503,
      );
    }
  }

  async compareAndSet(code: string, version: number | null, next: RoomRecord) {
    // Keep an expired record for seven days so an expired invitation has a useful error.
    const retention = Math.max(1_000, next.expiresAt - Date.now()) + 7 * 86_400_000;
    return (
      (await this.command<number>(
        'EVAL',
        CAS_SCRIPT,
        3,
        `xiangqi:room:${code}`,
        'xiangqi:expiry',
        `xiangqi:events:${code}`,
        version === null ? 'new' : version,
        JSON.stringify(next),
        retention,
        next.expiresAt,
        code,
        next.version,
        Date.now() - 7 * 86_400_000,
      )) === 1
    );
  }

  async rateLimit(key: string, limit: number, windowMs: number, now: number) {
    const bucket = Math.floor(now / windowMs);
    const count = await this.command<number>(
      'EVAL',
      RATE_SCRIPT,
      1,
      `xiangqi:rate:${key}:${bucket}`,
      windowMs * 2,
    );
    return count <= limit;
  }

  async updates(code: string, after: string) {
    type StreamRead = [string, [string, string[]][]][] | null;
    const data = await this.command<StreamRead>(
      'XREAD',
      'COUNT',
      100,
      'STREAMS',
      `xiangqi:events:${code}`,
      after,
    );
    const entries = data?.[0]?.[1];
    const last = entries?.at(-1);
    return last ? { id: last[0], version: Number(last[1][1]) } : null;
  }
}

export class LocalRoomStore implements RoomStore {
  kind = 'local' as const;
  private buckets = new Map<string, { count: number; expires: number }>();

  constructor(private path = resolve(process.cwd(), '.data', 'rooms.json')) {}

  private async all(): Promise<Record<string, RoomRecord>> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as Record<string, RoomRecord>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new RoomError(
        'Local room data is unavailable. Please retry.',
        'STORAGE_UNAVAILABLE',
        503,
      );
    }
  }

  async get(code: string) {
    return (await this.all())[code] ?? null;
  }

  async compareAndSet(code: string, version: number | null, next: RoomRecord) {
    // shortcut: a file lock is for one development machine; deployed rooms always use Redis.
    await mkdir(dirname(this.path), { recursive: true });
    const lock = `${this.path}.lock`;
    let acquired = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await mkdir(lock);
        acquired = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await new Promise((done) => setTimeout(done, 10));
      }
    }
    if (!acquired) throw new RoomError('The room is busy. Please retry.', 'ROOM_BUSY', 503);
    try {
      const records = await this.all();
      const current = records[code];
      if (version === null ? Boolean(current) : current?.version !== version) return false;
      records[code] = next;
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(records), { mode: 0o600 });
      await rename(temporary, this.path);
      return true;
    } finally {
      await rmdir(lock);
    }
  }

  async rateLimit(key: string, limit: number, windowMs: number, now: number) {
    if (this.buckets.size > 10_000) {
      for (const [entry, bucket] of this.buckets)
        if (bucket.expires <= now) this.buckets.delete(entry);
    }
    const previous = this.buckets.get(key);
    const bucket =
      previous && previous.expires > now ? previous : { count: 0, expires: now + windowMs };
    bucket.count++;
    this.buckets.set(key, bucket);
    return bucket.count <= limit;
  }

  async updates(code: string, after: string) {
    const room = await this.get(code);
    return room && room.version > Number(after.split('-')[0])
      ? { id: `${room.version}-0`, version: room.version }
      : null;
  }
}

let instance: RoomStore | undefined;
export function getStore(): RoomStore {
  if (instance) return instance;
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (url && token) instance = new RedisRoomStore(url, token);
  else if (
    process.env.NODE_ENV !== 'production' ||
    (process.env.E2E_TEST_MODE === '1' && !process.env.VERCEL)
  ) {
    instance = new LocalRoomStore(process.env.ROOM_STORE_FILE);
  } else {
    throw new RoomError(
      'Online rooms need Redis configured. Local practice is available now.',
      'STORAGE_NOT_CONFIGURED',
      503,
    );
  }
  return instance;
}

export function replaceStoreForTests(store?: RoomStore) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Test store replacement is disabled');
  instance = store;
}
