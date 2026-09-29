import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ClientStore } from './auth/clients.js';
import { authenticate, requireScope } from './auth/plugin.js';
import type { TokenService } from './auth/tokens.js';
import type { Config } from './config.js';
import type { Repo } from './db/repo.js';
import type { Answerer } from './generation/answerer.js';
import type { MlClient } from './ml/client.js';
import type { Metrics } from './observability/metrics.js';
import type { ReadinessCheck } from './observability/readiness.js';
import type { Retriever } from './retrieval/retriever.js';
import { collectionRoutes } from './routes/collections.js';
import { mcpRoutes } from './routes/mcp.js';
import { oauthRoutes } from './routes/oauth.js';
import { opsRoutes } from './routes/ops.js';
import { queryRoutes } from './routes/query.js';
import { searchRoutes } from './routes/search.js';

export interface AppDeps {
  config: Config;
  repo: Repo;
  ml: MlClient;
  retriever: Retriever;
  answerer: Answerer;
  clients: ClientStore;
  tokens: TokenService;
  metrics: Metrics;
  readinessChecks: Record<string, ReadinessCheck>;
}

// Build the app without listening on a port, so tests can drive it with app.inject().
// Dependencies are passed in, so tests can substitute fakes for Postgres, ml and the LLM.
export function buildApp(deps: AppDeps): FastifyInstance {
  const { config, repo, ml, retriever, answerer, clients, tokens, metrics } = deps;
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    // Correlation id: honour an incoming X-Request-Id (from a gateway) or mint one. It's on every
    // log line for the request (pino child logger) and echoed back, so a user-reported failure
    // can be traced to its logs.
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && /^[\w.-]{1,128}$/.test(incoming) ? incoming : randomUUID();
    },
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });
  app.addHook('onResponse', async (req, reply) => {
    // routeOptions.url is the template ("/collections/:collectionId/query"), not the concrete URL:
    // labelling by raw URL would create one time series per collection id (cardinality explosion).
    metrics.httpDuration.observe(
      { method: req.method, route: req.routeOptions.url ?? 'unmatched', status_code: reply.statusCode },
      reply.elapsedTime / 1000,
    );
  });

  app.register(formbody); // OAuth token requests are application/x-www-form-urlencoded
  app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
  app.register(rateLimit, { global: false });
  app.decorateRequest('clientId', '');
  app.decorateRequest('scopes', null as never);

  app.register(opsRoutes, { metrics, readinessChecks: deps.readinessChecks, metricsToken: config.METRICS_TOKEN });

  // Public: token issuance and the JWKS.
  app.register(oauthRoutes, {
    clients,
    tokens,
    issuer: config.JWT_ISSUER,
    baseUrl: config.PUBLIC_BASE_URL,
    mcpResource: config.MCP_RESOURCE,
  });

  // Everything else requires a valid access token and is scoped to its tenant.
  app.register(async (protectedApp) => {
    protectedApp.addHook('onRequest', authenticate((token) => tokens.verify(token)));
    protectedApp.addHook('preHandler', requireScope);
    const defaults = { mode: config.RETRIEVAL_MODE, topK: config.RETRIEVAL_TOP_K };
    await protectedApp.register(collectionRoutes, { repo, ml });
    await protectedApp.register(searchRoutes, { repo, retriever, defaults, metrics });
    await protectedApp.register(queryRoutes, { repo, answerer, defaults, metrics });
  });

  // The MCP endpoint is its own OAuth resource: it only accepts tokens whose audience is the MCP
  // resource URL, and its 401s advertise the protected-resource metadata (MCP authorization spec).
  app.register(async (mcpApp) => {
    mcpApp.addHook(
      'onRequest',
      authenticate((token) => tokens.verify(token, config.MCP_RESOURCE), {
        resourceMetadataUrl: `${config.PUBLIC_BASE_URL}/.well-known/oauth-protected-resource/mcp`,
      }),
    );
    mcpApp.addHook('preHandler', requireScope);
    await mcpApp.register(mcpRoutes, {
      repo,
      retriever,
      answerer,
      defaults: { mode: config.RETRIEVAL_MODE, topK: config.RETRIEVAL_TOP_K },
    });
  });

  return app;
}
