import type { Redis } from 'ioredis';

/**
 * Short-lived, single-use values for the authorization flow: pending authorization requests
 * (minutes) and authorization codes (60 seconds). Unlike the answer cache, failures here must
 * surface as errors, not silent misses, and `take` must be atomic so a code can be redeemed once.
 */
export interface AuthKV {
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  get(key: string): Promise<string | null>;
  /** Read and delete in one step (Redis GETDEL): two concurrent redemptions can't both succeed. */
  take(key: string): Promise<string | null>;
}

export function redisAuthKV(redis: Redis): AuthKV {
  return {
    set: async (key, value, ttl) => {
      await redis.set(key, value, 'EX', ttl);
    },
    get: (key) => redis.get(key),
    take: (key) => redis.getdel(key),
  };
}

export function memoryAuthKV(): AuthKV & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    set: async (key, value) => {
      store.set(key, value);
    },
    get: async (key) => store.get(key) ?? null,
    take: async (key) => {
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    },
  };
}
