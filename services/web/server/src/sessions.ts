import { createHash, randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Role } from './users.js';

export interface Session {
  userId: string;
  role: Role;
  csrf: string; // per-session CSRF token, sent back by the SPA in a header
  createdAt: number;
}

export interface SessionStore {
  create(userId: string, role: Role): Promise<{ sid: string; session: Session }>;
  get(sid: string): Promise<Session | null>;
  destroy(sid: string): Promise<void>;
  /** Log a user out everywhere (e.g. when an admin disables the account). */
  destroyAllForUser(userId: string): Promise<void>;
}

/** Minimal key-value surface used by the session store (Redis in production, a Map in tests). */
export interface KV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  expire(key: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  sadd(key: string, member: string, ttlSeconds: number): Promise<void>;
  smembers(key: string): Promise<string[]>;
}

// The cookie holds a random id; Redis holds only its hash. A leaked Redis dump or MONITOR
// output then contains no usable session ids.
const keyFor = (sid: string) => `sess:${createHash('sha256').update(sid).digest('hex')}`;

/**
 * Server-side sessions: the cookie is an opaque 256-bit random id, all state lives in Redis.
 * Unlike a JWT in the browser, a session can be revoked instantly (logout, account disabled).
 *  - idle timeout: each request extends the TTL (sliding expiry)
 *  - absolute timeout: sessions die after a fixed lifetime regardless of activity
 */
export function createSessionStore(kv: KV, opts: { idleSeconds: number; absoluteSeconds: number; now?: () => number }): SessionStore {
  const now = opts.now ?? Date.now;
  return {
    async create(userId, role) {
      const sid = randomBytes(32).toString('base64url');
      const session: Session = { userId, role, csrf: randomBytes(32).toString('base64url'), createdAt: now() };
      await kv.set(keyFor(sid), JSON.stringify(session), opts.idleSeconds);
      await kv.sadd(`user-sessions:${userId}`, keyFor(sid), opts.absoluteSeconds);
      return { sid, session };
    },
    async get(sid) {
      const raw = await kv.get(keyFor(sid));
      if (!raw) return null;
      const session = JSON.parse(raw) as Session;
      if (now() - session.createdAt > opts.absoluteSeconds * 1000) {
        await kv.del(keyFor(sid));
        return null;
      }
      await kv.expire(keyFor(sid), opts.idleSeconds);
      return session;
    },
    async destroy(sid) {
      await kv.del(keyFor(sid));
    },
    async destroyAllForUser(userId) {
      for (const key of await kv.smembers(`user-sessions:${userId}`)) await kv.del(key);
      await kv.del(`user-sessions:${userId}`);
    },
  };
}

export function redisKV(redis: Redis): KV {
  return {
    get: (k) => redis.get(k),
    set: async (k, v, ttl) => void (await redis.set(k, v, 'EX', ttl)),
    expire: async (k, ttl) => void (await redis.expire(k, ttl)),
    del: async (k) => void (await redis.del(k)),
    sadd: async (k, m, ttl) => void (await redis.multi().sadd(k, m).expire(k, ttl).exec()),
    smembers: (k) => redis.smembers(k),
  };
}

export function memoryKV(): KV {
  const values = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  return {
    get: async (k) => values.get(k) ?? null,
    set: async (k, v) => void values.set(k, v),
    expire: async () => {},
    del: async (k) => {
      values.delete(k);
      sets.delete(k);
    },
    sadd: async (k, m) => void sets.set(k, (sets.get(k) ?? new Set()).add(m)),
    smembers: async (k) => [...(sets.get(k) ?? [])],
  };
}
