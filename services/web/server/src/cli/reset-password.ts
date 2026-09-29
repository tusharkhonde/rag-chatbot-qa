/**
 * Break-glass password reset for a web user (e.g. a lost initial admin password).
 *
 *   docker compose exec web node dist/server/cli/reset-password.js --email admin@example.com [--password <pw>] [--enable]
 *
 * Deliberately a CLI, not an HTTP endpoint: it needs shell access to the container, which is the
 * same trust level as reading the logs where the initial password was printed. A reset also
 * revokes every existing session of the user, so anyone holding an old session is signed out.
 */
import { parseArgs } from 'node:util';
import { Redis } from 'ioredis';
import pg from 'pg';
import { createSessionStore, redisKV, type SessionStore } from '../sessions.js';
import { createUserStore, generatePassword, type UserStore } from '../users.js';

export async function resetPassword(
  users: UserStore,
  sessions: SessionStore,
  opts: { email: string; password?: string; enable?: boolean },
): Promise<{ email: string; password: string; generated: boolean }> {
  const user = await users.findByEmail(opts.email);
  if (!user) throw new Error(`No user with email ${opts.email}`);
  const password = opts.password ?? generatePassword();
  await users.setPassword(user.id, password);
  if (opts.enable && user.disabled) await users.setDisabled(user.id, false);
  await sessions.destroyAllForUser(user.id);
  return { email: user.email, password, generated: !opts.password };
}

// Only run when executed directly (the function above is imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: { email: { type: 'string' }, password: { type: 'string' }, enable: { type: 'boolean', default: false } },
  });
  if (!values.email) {
    console.error('usage: reset-password --email <email> [--password <pw>] [--enable]');
    process.exit(2);
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: 1 });
  try {
    // TTLs are irrelevant here: the store is only used to revoke sessions.
    const sessions = createSessionStore(redisKV(redis), { idleSeconds: 1, absoluteSeconds: 1 });
    const result = await resetPassword(createUserStore(pool), sessions, values as { email: string; password?: string; enable?: boolean });
    console.log(`Password reset for ${result.email}; all of their sessions were signed out.`);
    if (result.generated) console.log(`New password: ${result.password}\n(shown once)`);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  } finally {
    await pool.end();
    redis.disconnect();
  }
}
