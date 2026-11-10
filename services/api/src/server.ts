import { buildApp } from './app.js';
import { createClientStore } from './auth/clients.js';
import { redisAuthKV } from './auth/kv.js';
import { createRefreshTokenStore } from './auth/refreshTokens.js';
import { createUserDirectory } from './auth/users.js';
import { loadSigningKey } from './auth/keys.js';
import { createTokenService } from './auth/tokens.js';
import { createRedis, failSafe, redisCache } from './cache/cache.js';
import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { createRepo } from './db/repo.js';
import { createAnswerer } from './generation/answerer.js';
import { createCondenser } from './generation/condense.js';
import { createLlmClient } from './generation/llm.js';
import { createMlClient } from './ml/client.js';
import { createMetrics } from './observability/metrics.js';
import { createQueryEmbedder } from './retrieval/queryEmbedder.js';
import { createRetriever } from './retrieval/retriever.js';
import { createSearchStore } from './retrieval/search.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
await migrate(pool, config.MIGRATIONS_DIR, (msg) => console.log(msg));

const redis = createRedis(config.REDIS_URL);
const ml = createMlClient(config.ML_URL);
const cache = failSafe(redisCache(redis), (err, op) => console.warn(`cache ${op} failed: ${(err as Error).message}`));
const queryEmbedder = createQueryEmbedder(ml, cache);
const retriever = createRetriever(createSearchStore(pool, config.HNSW_EF_SEARCH), queryEmbedder, {
  candidates: config.RETRIEVAL_CANDIDATES,
});
const llm = createLlmClient({
  baseURL: config.LLM_BASE_URL,
  apiKey: config.LLM_API_KEY,
  model: config.LLM_MODEL,
  temperature: config.LLM_TEMPERATURE,
  maxTokens: config.LLM_MAX_TOKENS,
});
const condenser = config.CONDENSE_ENABLED
  ? createCondenser(llm, { maxMessages: config.CHAT_HISTORY_MAX_MESSAGES, maxTokens: config.CONDENSE_MAX_TOKENS })
  : undefined;
const answerer = createAnswerer({
  retriever,
  llm,
  condenser,
  cache,
  embeddingModelId: queryEmbedder.modelId,
  maxContextTokens: config.MAX_CONTEXT_TOKENS,
  cacheTtlSeconds: config.ANSWER_CACHE_TTL_SECONDS,
});
const tokens = createTokenService(await loadSigningKey(config.JWT_KEYS_DIR), {
  issuer: config.JWT_ISSUER,
  audience: config.JWT_AUDIENCE,
  ttlSeconds: config.ACCESS_TOKEN_TTL_SECONDS,
});

const readinessChecks = {
  postgres: () => pool.query('SELECT 1'),
  redis: () => redis.ping(),
  ml: async () => {
    const res = await fetch(`${config.ML_URL}/health`);
    if (!res.ok) throw new Error(`status ${res.status}`);
  },
  llm: async () => {
    const res = await fetch(`${config.LLM_BASE_URL}/models`, { headers: { authorization: `Bearer ${config.LLM_API_KEY}` } });
    if (!res.ok) throw new Error(`status ${res.status}`);
  },
};

const app = buildApp({
  config,
  repo: createRepo(pool),
  ml,
  retriever,
  answerer,
  condenser,
  clients: createClientStore(pool),
  tokens,
  users: createUserDirectory(pool),
  authKv: redisAuthKV(redis),
  refreshTokens: createRefreshTokenStore(pool),
  metrics: createMetrics({ hitThreshold: config.RETRIEVAL_HIT_THRESHOLD }),
  readinessChecks,
});
await app.listen({ host: '0.0.0.0', port: config.PORT });

// Graceful shutdown: stop accepting requests, let in-flight ones finish, then close the pool.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await pool.end();
    redis.disconnect();
    process.exit(0);
  });
}
