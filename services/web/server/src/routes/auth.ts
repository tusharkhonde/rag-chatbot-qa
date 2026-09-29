import type { FastifyPluginAsync } from 'fastify';
import type { sessionHooks } from '../auth.js';
import type { SessionStore } from '../sessions.js';
import type { User, UserStore } from '../users.js';

interface Deps {
  users: UserStore;
  sessions: SessionStore;
  hooks: ReturnType<typeof sessionHooks>;
  cookie: { name: string; secure: boolean; maxAgeSeconds: number };
}

export const publicUser = (u: User) => ({ id: u.id, email: u.email, name: u.name, role: u.role });

export const authRoutes: FastifyPluginAsync<Deps> = async (app, { users, sessions, hooks, cookie }) => {
  const cookieOptions = {
    httpOnly: true, // JavaScript can't read it, so an XSS bug can't exfiltrate the session
    secure: cookie.secure,
    sameSite: 'lax' as const, // not sent on cross-site POSTs (CSRF), still sent on top-level navigation
    path: '/',
    maxAge: cookie.maxAgeSeconds,
  };

  app.post<{ Body: { email: string; password: string } }>(
    '/login',
    {
      preHandler: hooks.checkOrigin, // login CSRF: a foreign site must not log you into its account
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, // slows password guessing
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          additionalProperties: false,
          properties: { email: { type: 'string', minLength: 3, maxLength: 254 }, password: { type: 'string', minLength: 1, maxLength: 256 } },
        },
      },
    },
    async (req, reply) => {
      const user = await users.authenticate(req.body.email, req.body.password);
      // One generic message for unknown email, wrong password and disabled account: no user enumeration.
      if (!user) return reply.code(401).send({ error: 'Invalid email or password' });

      // Session fixation defense: never reuse a pre-login session id; always issue a fresh one.
      if (req.sid) await sessions.destroy(req.sid);
      const { sid, session } = await sessions.create(user.id, user.role);
      req.log.info({ event: 'login', userId: user.id, role: user.role }, 'user signed in');
      return reply.setCookie(cookie.name, sid, cookieOptions).send({ user: publicUser(user), csrfToken: session.csrf });
    },
  );

  app.post('/logout', { preHandler: [hooks.requireSession, hooks.requireCsrf] }, async (req, reply) => {
    await sessions.destroy(req.sid!); // server-side revocation: the cookie is now worthless
    return reply.clearCookie(cookie.name, { path: '/' }).send({ ok: true });
  });

  app.get('/me', { preHandler: hooks.requireSession }, async (req, reply) => {
    const user = await users.get(req.session!.userId);
    if (!user || user.disabled) {
      await sessions.destroy(req.sid!);
      return reply.code(401).clearCookie(cookie.name, { path: '/' }).send({ error: 'Not signed in' });
    }
    return { user: publicUser(user), csrfToken: req.session!.csrf };
  });
};
