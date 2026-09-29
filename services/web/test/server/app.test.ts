import { describe, expect, it } from 'vitest';
import { as, login, ORIGIN, setup } from './helpers.js';

describe('login and sessions', () => {
  it('sets an HttpOnly, SameSite=Lax session cookie and returns the user + CSRF token', async () => {
    const { app } = setup();
    const { res, setCookie, csrf } = await login(app, 'Admin@Example.com', 'correct horse battery');
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toEqual({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'admin@example.com', name: 'Ada', role: 'admin' });
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/Path=\//);
    expect(csrf).toMatch(/^[\w-]{43}$/);
  });

  it('gives one generic error for a wrong password and an unknown email (no enumeration)', async () => {
    const { app } = setup();
    const wrong = await login(app, 'admin@example.com', 'nope nope nope');
    const unknown = await login(app, 'ghost@example.com', 'nope nope nope');
    expect(wrong.res.statusCode).toBe(401);
    expect(wrong.res.json()).toEqual(unknown.res.json());
  });

  it('rejects a login posted from another origin (login CSRF)', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST', url: '/api/auth/login', headers: { origin: 'https://evil.example' },
      payload: { email: 'admin@example.com', password: 'correct horse battery' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('issues a fresh session id at login and destroys the old one (session fixation)', async () => {
    const { app, sessions } = setup();
    const first = await login(app, 'user@example.com', 'another long password');
    const res = await app.inject({
      method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN, cookie: `sid=${first.sid}` },
      payload: { email: 'user@example.com', password: 'another long password' },
    });
    const second = /sid=([^;]+)/.exec(String(res.headers['set-cookie']))![1]!;
    expect(second).not.toBe(first.sid);
    expect(await sessions.get(first.sid)).toBeNull();
  });

  it('/me works with the cookie and 401s without it', async () => {
    const { app } = setup();
    const s = await login(app, 'user@example.com', 'another long password');
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `sid=${s.sid}` } })).json().user.role).toBe('user');
    expect((await app.inject({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401);
  });

  it('logout revokes the session server-side', async () => {
    const { app } = setup();
    const s = await login(app, 'user@example.com', 'another long password');
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: as(s) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `sid=${s.sid}` } })).statusCode).toBe(401);
  });
});

describe('CSRF protection on writes', () => {
  it('rejects a write without the CSRF header, or with a wrong one', async () => {
    const { app } = setup();
    const s = await login(app, 'admin@example.com', 'correct horse battery');
    const post = (headers: Record<string, string>) =>
      app.inject({ method: 'POST', url: '/api/collections', headers, payload: { name: 'x' } });
    expect((await post({ cookie: `sid=${s.sid}`, origin: ORIGIN })).statusCode).toBe(403);
    expect((await post(as({ ...s, csrf: 'forged' }))).statusCode).toBe(403);
    expect((await post(as(s))).statusCode).toBe(201);
  });

  it('rejects a write from a foreign Origin even with a valid token', async () => {
    const { app } = setup();
    const s = await login(app, 'admin@example.com', 'correct horse battery');
    const res = await app.inject({ method: 'POST', url: '/api/collections', headers: as(s, { origin: 'https://evil.example' }), payload: { name: 'x' } });
    expect(res.statusCode).toBe(403);
  });
});

describe('roles', () => {
  it("a chat user can read and chat, but can't create collections, upload or manage users", async () => {
    const { app, calls } = setup();
    const s = await login(app, 'user@example.com', 'another long password');
    expect((await app.inject({ method: 'GET', url: '/api/collections', headers: as(s) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/collections', headers: as(s), payload: { name: 'x' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/admin/users', headers: as(s) })).statusCode).toBe(403);
    const form = new FormData();
    form.append('file', new Blob(['# hi']), 'a.md');
    const upload = await app.inject({ method: 'POST', url: '/api/collections/11111111-1111-4111-8111-111111111111/documents', headers: as(s), payload: form });
    expect(upload.statusCode).toBe(403);
    // Every call that reached the RAG API was made with the user's (query-only) credentials.
    expect(calls.map((c) => `${c.role}:${c.method}`)).toEqual(['user:listCollections']);
  });

  it('an admin uploads through the admin (write-scoped) API client', async () => {
    const { app, calls } = setup();
    const s = await login(app, 'admin@example.com', 'correct horse battery');
    const form = new FormData();
    form.append('file', new Blob(['# hi']), 'a.md');
    const res = await app.inject({ method: 'POST', url: '/api/collections/11111111-1111-4111-8111-111111111111/documents', headers: as(s), payload: form });
    expect(res.statusCode).toBe(201);
    expect(calls.at(-1)).toMatchObject({ role: 'admin', method: 'upload', args: ['11111111-1111-4111-8111-111111111111', 'a.md'] });
  });

  it('disabling a user revokes all of their sessions immediately', async () => {
    const { app } = setup();
    const admin = await login(app, 'admin@example.com', 'correct horse battery');
    const user = await login(app, 'user@example.com', 'another long password');
    const res = await app.inject({ method: 'PATCH', url: '/api/admin/users/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', headers: as(admin), payload: { disabled: true } });
    expect(res.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `sid=${user.sid}` } })).statusCode).toBe(401);
    expect((await login(app, 'user@example.com', 'another long password')).res.statusCode).toBe(401);
  });

  it("an admin can't disable their own account", async () => {
    const { app } = setup();
    const s = await login(app, 'admin@example.com', 'correct horse battery');
    expect((await app.inject({ method: 'PATCH', url: '/api/admin/users/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', headers: as(s), payload: { disabled: true } })).statusCode).toBe(400);
  });
});

describe('chat', () => {
  it('streams the RAG API response through as Server-Sent Events', async () => {
    const { app, sse, calls } = setup();
    const s = await login(app, 'user@example.com', 'another long password');
    const res = await app.inject({
      method: 'POST', url: '/api/chat', headers: as(s),
      payload: { collectionId: '11111111-1111-4111-8111-111111111111', question: 'hello?' },
    });
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toBe(sse);
    expect(calls.at(-1)).toMatchObject({ role: 'user', method: 'queryStream' });
  });

  it('requires a signed-in session', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'POST', url: '/api/chat', payload: { collectionId: '11111111-1111-4111-8111-111111111111', question: 'x' } });
    expect(res.statusCode).toBe(401);
  });

  it('sends a strict Content-Security-Policy', async () => {
    const { app } = setup();
    const csp = String((await app.inject({ method: 'GET', url: '/health' })).headers['content-security-policy']);
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
