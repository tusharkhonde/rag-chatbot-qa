import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Session, SessionStore } from './sessions.js';
import type { Role } from './users.js';

declare module 'fastify' {
  interface FastifyRequest {
    session: Session | null;
    sid: string | null;
  }
}

/**
 * With Secure cookies we use the __Host- prefix: browsers then refuse the cookie unless it's
 * Secure, Path=/ and has no Domain, so a subdomain can't plant or overwrite it.
 * (Browsers only accept __Host- cookies over HTTPS, hence plain `sid` for the localhost demo.)
 */
export const cookieName = (secure: boolean) => (secure ? '__Host-sid' : 'sid');

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function sessionHooks(opts: { sessions: SessionStore; cookie: string; allowedOrigins: string[] }) {
  /** onRequest: attach the session (if any). Never rejects by itself. */
  async function loadSession(req: FastifyRequest) {
    const sid = req.cookies[opts.cookie];
    req.sid = sid ?? null;
    req.session = sid ? await opts.sessions.get(sid) : null;
  }

  async function requireSession(req: FastifyRequest, reply: FastifyReply) {
    if (!req.session) return reply.code(401).send({ error: 'Not signed in' });
  }

  /**
   * CSRF defense for state-changing requests, in two layers:
   *  1. Origin check: a browser always sends Origin on cross-site POSTs; reject foreign origins.
   *  2. Synchronizer token: the session's random csrf token must come back in X-CSRF-Token.
   *     A cross-site attacker can make the browser send the cookie, but can't read the token.
   * (SameSite=Lax cookies already block most cross-site POSTs; these don't rely on it.)
   */
  async function checkOrigin(req: FastifyRequest, reply: FastifyReply) {
    const origin = req.headers.origin;
    if (origin && !opts.allowedOrigins.includes(origin)) return reply.code(403).send({ error: 'Cross-origin request rejected' });
  }

  async function requireCsrf(req: FastifyRequest, reply: FastifyReply) {
    if (req.method === 'GET' || req.method === 'HEAD') return;
    const denied = await checkOrigin(req, reply);
    if (denied) return denied;
    const token = req.headers['x-csrf-token'];
    if (typeof token !== 'string' || !req.session || !safeEqual(token, req.session.csrf)) {
      return reply.code(403).send({ error: 'Missing or invalid CSRF token' });
    }
  }

  const requireRole = (role: Role) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.session?.role !== role) return reply.code(403).send({ error: `Requires the ${role} role` });
  };

  return { loadSession, requireSession, checkOrigin, requireCsrf, requireRole };
}
