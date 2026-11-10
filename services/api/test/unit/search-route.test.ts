import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { Repo } from '../../src/db/repo.js';
import type { Condenser } from '../../src/generation/condense.js';
import { createMetrics } from '../../src/observability/metrics.js';
import type { Retriever } from '../../src/retrieval/retriever.js';
import { auth, fakeAuth } from './helpers.js';

const OWNED = '11111111-1111-4111-8111-111111111111';

function setup() {
  const repo = { getCollection: vi.fn(async (_c: string, id: string) => (id === OWNED ? { id, name: 'd', version: 1, createdAt: '' } : null)) } as unknown as Repo;
  const retriever: Retriever = {
    retrieve: vi.fn(async () => ({ mode: 'hybrid' as const, chunks: [], topVectorScore: null, embeddingCached: false, timings: {} })),
  };
  const condenser: Condenser = {
    condense: vi.fn(async (_h, q) => (q === 'and its retention?' ? { question: 'Nimbus Queue retention', condensed: true, usage: null } : { question: q, condensed: false, usage: null })),
  };
  const app = buildApp({
    config: loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'fatal' }),
    repo, ml: {} as never, retriever, answerer: {} as never, condenser,
    ...fakeAuth('client-a'),
    metrics: createMetrics({ hitThreshold: 0.6 }),
    readinessChecks: {},
  });
  return { app, retriever, condenser };
}

describe('POST /collections/:id/search', () => {
  it('condenses a follow-up when history is given and reports the query it searched with', async () => {
    const { app, retriever } = setup();
    const res = await app.inject({
      method: 'POST', url: `/collections/${OWNED}/search`, headers: auth,
      payload: { query: 'and its retention?', history: [{ role: 'user', content: 'What is Nimbus Queue?' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().condensedQuery).toBe('Nimbus Queue retention');
    expect(vi.mocked(retriever.retrieve).mock.calls[0]![0].query).toBe('Nimbus Queue retention');
  });

  it('searches the raw query without history (no LLM call)', async () => {
    const { app, retriever, condenser } = setup();
    const res = await app.inject({ method: 'POST', url: `/collections/${OWNED}/search`, headers: auth, payload: { query: 'rollback' } });
    expect(res.json().condensedQuery).toBeNull();
    expect(condenser.condense).not.toHaveBeenCalled();
    expect(vi.mocked(retriever.retrieve).mock.calls[0]![0].query).toBe('rollback');
  });
});
