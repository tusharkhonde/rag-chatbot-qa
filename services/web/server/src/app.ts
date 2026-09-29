import { existsSync } from 'node:fs';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { ApiError, type ApiClient } from './apiClient.js';
import { cookieName, sessionHooks } from './auth.js';
import type { Config } from './config.js';
import { appRoutes } from './routes/app.js';
import { authRoutes } from './routes/auth.js';
import type { SessionStore } from './sessions.js';
import type { UserStore } from './users.js';

export interface AppDeps {
  config: Pick<Config, 'LOG_LEVEL' | 'PUBLIC_ORIGIN' | 'COOKIE_SECURE' | 'SESSION_ABSOLUTE_SECONDS' | 'STATIC_DIR'>;
  users: UserStore;
  sessions: SessionStore;
  api: ApiClient;
}

export function buildApp({ config, users, sessions, api }: AppDeps): FastifyInstance {
  const app = Fastify({ logger: { level: config.LOG_LEVEL } });

  app.register(cookie);
  app.register(rateLimit, { global: false });
  app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
  // Security headers. The CSP allows scripts/styles only from our own origin: no inline scripts,
  // no third-party CDNs. Even if an XSS payload got into the page, the browser wouldn't run it.
  app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"], // clickjacking: never render inside someone else's frame
        formAction: ["'self'"],
        upgradeInsecureRequests: config.COOKIE_SECURE ? [] : null,
      },
    },
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      const message = (err.body as { error?: string } | null)?.error ?? 'Upstream error';
      return reply.code(err.status >= 500 ? 502 : err.status).send({ error: message });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'request failed');
    return reply.code(status).send({ error: status >= 500 ? 'Internal error' : (err as Error).message });
  });

  app.get('/health', async () => ({ status: 'ok' }));

  const name = cookieName(config.COOKIE_SECURE);
  const hooks = sessionHooks({
    sessions,
    cookie: name,
    allowedOrigins: config.PUBLIC_ORIGIN.split(',').map((o) => o.trim()),
  });

  app.register(
    async (api_) => {
      api_.addHook('onRequest', hooks.loadSession);
      await api_.register(authRoutes, {
        prefix: '/auth',
        users,
        sessions,
        hooks,
        cookie: { name, secure: config.COOKIE_SECURE, maxAgeSeconds: config.SESSION_ABSOLUTE_SECONDS },
      });
      await api_.register(async (signedIn) => {
        signedIn.addHook('preHandler', hooks.requireSession);
        signedIn.addHook('preHandler', hooks.requireCsrf);
        await signedIn.register(appRoutes, { api, users, sessions, hooks });
      });
    },
    { prefix: '/api' },
  );

  // The React build. Unknown non-API GETs get index.html so client-side routes survive a reload.
  if (existsSync(config.STATIC_DIR)) {
    app.register(fastifyStatic, { root: config.STATIC_DIR, wildcard: false });
    app.setNotFoundHandler((req, reply) =>
      req.method === 'GET' && !req.url.startsWith('/api/') ? reply.sendFile('index.html') : reply.code(404).send({ error: 'Not found' }),
    );
  }

  return app;
}
