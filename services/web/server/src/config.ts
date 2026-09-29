import { readFileSync } from 'node:fs';
import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const Env = z.object({
  PORT: z.coerce.number().int().default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  RAG_API_URL: z.string().default('http://localhost:3000'),
  // Either explicit credentials, or a JSON file written by the compose bootstrap job.
  RAG_CLIENT_ID: z.string().optional(),
  RAG_CLIENT_SECRET: z.string().optional(),
  RAG_CREDENTIALS_FILE: z.string().optional(),
  // The origin the browser uses. State-changing requests from any other Origin are rejected.
  PUBLIC_ORIGIN: z.string().default('http://localhost:8080'),
  // Secure cookies require HTTPS; localhost demo runs plain HTTP. Set true behind TLS.
  COOKIE_SECURE: bool.default(false),
  SESSION_IDLE_SECONDS: z.coerce.number().int().min(60).default(2 * 3600),
  SESSION_ABSOLUTE_SECONDS: z.coerce.number().int().min(300).default(12 * 3600),
  STATIC_DIR: z.string().default(new URL('../../dist/client', import.meta.url).pathname),
  // First-run bootstrap: if no users exist, create this admin (password generated if unset).
  ADMIN_EMAIL: z.string().default('admin@example.com'),
  ADMIN_PASSWORD: z.string().optional(),
});

export type Config = z.infer<typeof Env> & { ragClientId: string; ragClientSecret: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  const c = parsed.data;
  let id = c.RAG_CLIENT_ID;
  let secret = c.RAG_CLIENT_SECRET;
  if ((!id || !secret) && c.RAG_CREDENTIALS_FILE) {
    const creds = JSON.parse(readFileSync(c.RAG_CREDENTIALS_FILE, 'utf8')) as { client_id: string; client_secret: string };
    id = creds.client_id;
    secret = creds.client_secret;
  }
  if (!id || !secret) throw new Error('RAG API credentials missing: set RAG_CLIENT_ID/RAG_CLIENT_SECRET or RAG_CREDENTIALS_FILE');
  return { ...c, ragClientId: id, ragClientSecret: secret };
}
