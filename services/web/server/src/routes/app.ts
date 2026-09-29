import type { FastifyPluginAsync } from 'fastify';
import type { ApiClient } from '../apiClient.js';
import type { sessionHooks } from '../auth.js';
import type { SessionStore } from '../sessions.js';
import { DuplicateEmailError, WeakPasswordError, type Role, type UserStore } from '../users.js';
import { publicUser } from './auth.js';

interface Deps {
  api: ApiClient;
  users: UserStore;
  sessions: SessionStore;
  hooks: ReturnType<typeof sessionHooks>;
}

const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;

/** Signed-in routes. Every request here has passed requireSession and (for writes) requireCsrf. */
export const appRoutes: FastifyPluginAsync<Deps> = async (app, { api, users, sessions, hooks }) => {
  const admin = hooks.requireRole('admin');
  const rag = (role: Role) => api.forRole(role);

  // ---------------------------------------------------------------- collections & documents

  app.get('/collections', async (req) => rag(req.session!.role).listCollections());

  app.post<{ Body: { name: string } }>(
    '/collections',
    {
      preHandler: admin,
      schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 100 } } } },
    },
    async (req, reply) => reply.code(201).send(await rag(req.session!.role).createCollection(req.body.name)),
  );

  app.get<{ Params: { id: string } }>('/collections/:id/documents', { schema: { params: idParams } }, async (req) =>
    rag(req.session!.role).listDocuments(req.params.id),
  );

  app.post<{ Params: { id: string } }>('/collections/:id/documents', { preHandler: admin, schema: { params: idParams } }, async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'Expected a multipart "file" field' });
    const data = await file.toBuffer();
    const { status, body } = await rag(req.session!.role).upload(req.params.id, { filename: file.filename, mimeType: file.mimetype, data });
    req.log.info({ event: 'upload', userId: req.session!.userId, filename: file.filename, status }, 'document upload');
    return reply.code(status >= 500 ? 502 : status).send(body);
  });

  // ---------------------------------------------------------------- chat (streamed)

  app.post<{ Body: { collectionId: string; question: string } }>(
    '/chat',
    {
      schema: {
        body: {
          type: 'object',
          required: ['collectionId', 'question'],
          additionalProperties: false,
          properties: { collectionId: { type: 'string', format: 'uuid' }, question: { type: 'string', minLength: 1, maxLength: 1000 } },
        },
      },
    },
    async (req, reply) => {
      const abort = new AbortController();
      const upstream = await rag(req.session!.role).queryStream(req.body.collectionId, req.body.question, abort.signal);
      if (!upstream.ok || !upstream.body) {
        const body = (await upstream.json().catch(() => null)) as { error?: string } | null;
        return reply.code(upstream.status >= 500 ? 502 : upstream.status).send({ error: body?.error ?? 'Chat request failed' });
      }

      // Pass the API's Server-Sent Events straight through: the BFF adds auth, not buffering.
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      // Browser tab closed / Stop pressed → abort the upstream request, which aborts the LLM call.
      res.on('close', () => {
        if (!res.writableFinished) abort.abort();
      });
      try {
        for await (const chunk of upstream.body) res.write(chunk);
      } catch {
        if (!abort.signal.aborted) res.write(`event: error\ndata: ${JSON.stringify({ error: 'Stream interrupted' })}\n\n`);
      } finally {
        res.end();
      }
    },
  );

  // ---------------------------------------------------------------- user management (admin)

  app.get('/admin/users', { preHandler: admin }, async () => ({ users: await users.list() }));

  app.post<{ Body: { email: string; name: string; password: string; role: Role } }>(
    '/admin/users',
    {
      preHandler: admin,
      schema: {
        body: {
          type: 'object',
          required: ['email', 'name', 'password', 'role'],
          additionalProperties: false,
          properties: {
            email: { type: 'string', format: 'email', maxLength: 254 },
            name: { type: 'string', minLength: 1, maxLength: 100 },
            password: { type: 'string', maxLength: 256 },
            role: { type: 'string', enum: ['admin', 'user'] },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const user = await users.create(req.body);
        req.log.info({ event: 'user_created', by: req.session!.userId, userId: user.id, role: user.role }, 'user created');
        return reply.code(201).send({ user: publicUser(user) });
      } catch (err) {
        if (err instanceof DuplicateEmailError) return reply.code(409).send({ error: err.message });
        if (err instanceof WeakPasswordError) return reply.code(400).send({ error: err.message });
        throw err;
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: { disabled: boolean } }>(
    '/admin/users/:id',
    {
      preHandler: admin,
      schema: {
        params: idParams,
        body: { type: 'object', required: ['disabled'], additionalProperties: false, properties: { disabled: { type: 'boolean' } } },
      },
    },
    async (req, reply) => {
      if (req.params.id === req.session!.userId) return reply.code(400).send({ error: "You can't disable your own account" });
      const user = await users.setDisabled(req.params.id, req.body.disabled);
      if (!user) return reply.code(404).send({ error: 'User not found' });
      // Disabling takes effect immediately: every session of that user is revoked server-side.
      if (req.body.disabled) await sessions.destroyAllForUser(user.id);
      return { user };
    },
  );
};
