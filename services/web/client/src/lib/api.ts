import type { AdminUser, Collection, DocumentSummary, Role, User } from './types';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// The CSRF token comes from /api/auth/me or /login and is sent back on every write.
// It lives in memory only: never in localStorage, where any injected script could read it.
let csrfToken = '';
export const setCsrfToken = (token: string) => (csrfToken = token);

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(path, {
    method,
    credentials: 'same-origin', // send the HttpOnly session cookie
    headers: {
      ...(body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'x-csrf-token': csrfToken } : {}),
    },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

type Session = { user: User; csrfToken: string };

export const api = {
  me: () => request<Session>('GET', '/api/auth/me'),
  login: (email: string, password: string) => request<Session>('POST', '/api/auth/login', { email, password }),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout'),

  collections: () => request<{ collections: Collection[] }>('GET', '/api/collections').then((r) => r.collections),
  createCollection: (name: string) => request<Collection>('POST', '/api/collections', { name }),
  documents: (collectionId: string) =>
    request<{ documents: DocumentSummary[] }>('GET', `/api/collections/${collectionId}/documents`).then((r) => r.documents),
  upload: (collectionId: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<{ documentId: string; created: boolean; chunkCount: number }>('POST', `/api/collections/${collectionId}/documents`, form);
  },

  users: () => request<{ users: AdminUser[] }>('GET', '/api/admin/users').then((r) => r.users),
  createUser: (input: { email: string; name: string; password: string; role: Role }) =>
    request<{ user: User }>('POST', '/api/admin/users', input),
  setDisabled: (id: string, disabled: boolean) => request<{ user: AdminUser }>('PATCH', `/api/admin/users/${id}`, { disabled }),

  /** Streamed answer. Returns the raw response; read it with readSSE(). */
  chat: (collectionId: string, question: string, signal: AbortSignal) =>
    fetch('/api/chat', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken, accept: 'text/event-stream' },
      body: JSON.stringify({ collectionId, question }),
      signal,
    }),
};
