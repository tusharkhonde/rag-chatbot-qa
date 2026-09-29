import { vi } from 'vitest';
import type { ApiClient, RagApi } from '../../server/src/apiClient.js';
import { buildApp } from '../../server/src/app.js';
import { createSessionStore, memoryKV } from '../../server/src/sessions.js';
import type { Role, User, UserStore } from '../../server/src/users.js';

export const ORIGIN = 'http://localhost:8080';

export function fakeUsers(): UserStore & { all: (User & { password: string })[] } {
  const all: (User & { password: string })[] = [
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'admin@example.com', name: 'Ada', role: 'admin', disabled: false, createdAt: '', lastLoginAt: null, password: 'correct horse battery' },
    { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', email: 'user@example.com', name: 'Uma', role: 'user', disabled: false, createdAt: '', lastLoginAt: null, password: 'another long password' },
  ];
  const strip = ({ password: _p, ...u }: User & { password: string }): User => u;
  return {
    all,
    count: async () => all.length,
    create: vi.fn(async (input) => {
      const user = { ...input, id: `u-${all.length}`, disabled: false, createdAt: '', lastLoginAt: null };
      all.push(user);
      return strip(user);
    }),
    authenticate: async (email, password) => {
      const u = all.find((x) => x.email === email.toLowerCase());
      return u && u.password === password && !u.disabled ? strip(u) : null;
    },
    get: async (id) => {
      const u = all.find((x) => x.id === id);
      return u ? strip(u) : null;
    },
    list: async () => all.map(strip),
    findByEmail: async (email) => {
      const u = all.find((x) => x.email === email.toLowerCase());
      return u ? strip(u) : null;
    },
    setPassword: async (id, password) => {
      const u = all.find((x) => x.id === id);
      if (u) u.password = password;
    },
    setDisabled: async (id, disabled) => {
      const u = all.find((x) => x.id === id);
      if (!u) return null;
      u.disabled = disabled;
      return strip(u);
    },
  };
}

export function fakeApi() {
  const calls: { role: Role; method: string; args: unknown[] }[] = [];
  const sse = 'event: sources\ndata: {"sources":[]}\n\nevent: delta\ndata: {"text":"Hi [1]"}\n\nevent: done\ndata: {"answer":"Hi [1]"}\n\n';
  const api: ApiClient = {
    forRole: (role) => {
      const rec = (method: string) => (...args: unknown[]) => {
        calls.push({ role, method, args });
      };
      const impl: RagApi = {
        listCollections: async () => (rec('listCollections')(), { collections: [{ id: 'c1', name: 'docs' }] }),
        createCollection: async (name) => (rec('createCollection')(name), { id: 'c2', name }),
        listDocuments: async (id) => (rec('listDocuments')(id), { documents: [] }),
        upload: async (id, file) => (rec('upload')(id, file.filename), { status: 201, body: { documentId: 'd1', created: true, chunkCount: 3 } }),
        queryStream: async (id, question) => {
          rec('queryStream')(id, question);
          return new Response(new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode(sse)), c.close()) }), {
            headers: { 'content-type': 'text/event-stream' },
          });
        },
      };
      return impl;
    },
  };
  return { api, calls, sse };
}

export function setup() {
  const users = fakeUsers();
  const sessions = createSessionStore(memoryKV(), { idleSeconds: 3600, absoluteSeconds: 7200 });
  const { api, calls, sse } = fakeApi();
  const app = buildApp({
    config: { LOG_LEVEL: 'fatal', PUBLIC_ORIGIN: ORIGIN, COOKIE_SECURE: false, SESSION_ABSOLUTE_SECONDS: 7200, STATIC_DIR: '/nonexistent' },
    users,
    sessions,
    api,
  });
  return { app, users, sessions, calls, sse };
}

type App = ReturnType<typeof setup>['app'];

/** Log in and return the cookie + CSRF token a browser would hold. */
export async function login(app: App, email: string, password: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email, password } });
  const setCookie = String(res.headers['set-cookie'] ?? '');
  const sid = /sid=([^;]+)/.exec(setCookie)?.[1] ?? '';
  return { res, sid, setCookie, csrf: res.json().csrfToken as string };
}

export const as = (s: { sid: string; csrf: string }, extra: Record<string, string> = {}) => ({
  cookie: `sid=${s.sid}`,
  'x-csrf-token': s.csrf,
  origin: ORIGIN,
  ...extra,
});
