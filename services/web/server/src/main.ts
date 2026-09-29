import { Redis } from 'ioredis';
import pg from 'pg';
import { createApiClient } from './apiClient.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createSessionStore, redisKV } from './sessions.js';
import { createUserStore, generatePassword } from './users.js';

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 5 });
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 });
const users = createUserStore(pool);

// First run: create an admin so someone can sign in. A generated password is printed once to the
// logs (docker compose logs web); it never has to live in a config file.
if ((await users.count()) === 0) {
  const password = config.ADMIN_PASSWORD || generatePassword(); // compose passes unset vars as ""
  await users.create({ email: config.ADMIN_EMAIL, name: 'Administrator', password, role: 'admin' });
  console.log(
    `\n  Initial admin created: ${config.ADMIN_EMAIL}` +
      (config.ADMIN_PASSWORD ? ' (password from ADMIN_PASSWORD)' : `\n  Password: ${password}\n  (shown once; container logs are lost when the container is recreated)`) +
      `\n  Lost it? docker compose exec web node dist/server/cli/reset-password.js --email ${config.ADMIN_EMAIL}` +
      '\n',
  );
}

const app = buildApp({
  config,
  users,
  sessions: createSessionStore(redisKV(redis), {
    idleSeconds: config.SESSION_IDLE_SECONDS,
    absoluteSeconds: config.SESSION_ABSOLUTE_SECONDS,
  }),
  api: createApiClient({ baseUrl: config.RAG_API_URL, clientId: config.ragClientId, clientSecret: config.ragClientSecret }),
});
await app.listen({ host: '0.0.0.0', port: config.PORT });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    await pool.end();
    redis.disconnect();
    process.exit(0);
  });
}
