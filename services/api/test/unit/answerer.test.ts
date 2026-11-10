import { describe, expect, it, vi } from 'vitest';
import { memoryCache } from '../../src/cache/cache.js';
import type { Collection } from '../../src/db/repo.js';
import { createAnswerer, normalizeForCache, type AnswerEvent } from '../../src/generation/answerer.js';
import type { Condenser, HistoryMessage } from '../../src/generation/condense.js';
import type { LlmClient, LlmEvent } from '../../src/generation/llm.js';
import { REFUSAL } from '../../src/generation/prompt.js';
import type { RetrieveResult, Retriever } from '../../src/retrieval/retriever.js';

const collection: Collection = { id: 'col-1', name: 'docs', version: 1, createdAt: 'now' };

const retrieval = (chunks = 2): RetrieveResult => ({
  mode: 'hybrid',
  topVectorScore: 0.71,
  embeddingCached: false,
  timings: { embed: 5, vector_search: 2, keyword_search: 1 },
  chunks: Array.from({ length: chunks }, (_, i) => ({
    chunkId: `c${i + 1}`, documentId: 'd1', filename: 'runbook.md', ordinal: i,
    content: `chunk ${i + 1}`, metadata: {}, score: 1 / (i + 1),
  })),
});

function fakeLlm(tokens: string[]): LlmClient & { calls: number } {
  const llm = {
    model: 'qwen2.5:7b',
    calls: 0,
    async *stream(): AsyncIterable<LlmEvent> {
      llm.calls++;
      for (const text of tokens) yield { type: 'delta', text };
      yield { type: 'usage', usage: { promptTokens: 120, completionTokens: tokens.length } };
    },
  };
  return llm;
}

/** Fake condenser: maps a follow-up to a fixed standalone question (or leaves it unchanged). */
function fakeCondenser(rewrite: Record<string, string>): Condenser & { calls: number } {
  const condenser = {
    calls: 0,
    async condense(history: HistoryMessage[], question: string) {
      condenser.calls++;
      const out = rewrite[question] ?? question;
      return { question: out, condensed: out !== question, usage: { promptTokens: 40, completionTokens: 10 } };
    },
  };
  return condenser;
}

function setup(tokens = ['Run ', 'rollback [1]', ' and see [9].'], chunks = 2, condenser?: Condenser) {
  const retriever: Retriever = { retrieve: vi.fn(async () => retrieval(chunks)) };
  const llm = fakeLlm(tokens);
  const cache = memoryCache();
  const answerer = createAnswerer({
    retriever, llm, cache, embeddingModelId: async () => 'ollama:nomic-embed-text',
    maxContextTokens: 3000, cacheTtlSeconds: 60, condenser,
  });
  return { answerer, retriever, llm, cache };
}

const req = (question = 'How do I roll back?', col = collection) =>
  ({ clientId: 'client-a', collection: col, question, mode: 'hybrid' as const, topK: 5 });

describe('answerer', () => {
  it('streams sources first, then deltas, then a done event with citations and usage', async () => {
    const { answerer } = setup();
    const events: AnswerEvent[] = [];
    for await (const e of answerer.stream(req())) events.push(e);

    expect(events.map((e) => e.type)).toEqual(['sources', 'delta', 'delta', 'delta', 'done']);
    const done = events.at(-1) as Extract<AnswerEvent, { type: 'done' }>;
    expect(done.result.answer).toBe('Run rollback [1] and see [9].');
    expect(done.result.citations.map((c) => c.chunkId)).toEqual(['c1']);
    expect(done.result.invalidCitations).toEqual([9]);
    expect(done.result.usage).toEqual({ promptTokens: 120, completionTokens: 3 });
    expect(done.result.timings).toHaveProperty('ttft');
    expect(done.result.timings).toHaveProperty('generate');
  });

  it('serves a repeated (differently punctuated) question from cache without retrieval or LLM', async () => {
    const { answerer, retriever, llm } = setup();
    await answerer.answer(req('How do I roll back?'));
    const second = await answerer.answer(req('  how do i roll BACK  '));
    expect(second.cached).toBe(true);
    expect(second.answer).toBe('Run rollback [1] and see [9].');
    expect(retriever.retrieve).toHaveBeenCalledTimes(1);
    expect(llm.calls).toBe(1);
  });

  it('misses the cache after new documents bump the collection version', async () => {
    const { answerer, llm } = setup();
    await answerer.answer(req());
    const after = await answerer.answer(req(undefined, { ...collection, version: 2 }));
    expect(after.cached).toBe(false);
    expect(llm.calls).toBe(2);
  });

  it('never shares cache entries across tenants', async () => {
    const { answerer, llm } = setup();
    await answerer.answer(req());
    await answerer.answer({ ...req(), clientId: 'client-b' });
    expect(llm.calls).toBe(2);
  });

  it('refuses without calling the LLM when retrieval finds nothing', async () => {
    const { answerer, llm } = setup(undefined, 0);
    const result = await answerer.answer(req());
    expect(result).toMatchObject({ answer: REFUSAL, refused: true, sources: [] });
    expect(llm.calls).toBe(0);
  });

  it('does not cache an answer whose stream was aborted', async () => {
    const { answerer, cache } = setup();
    const abort = new AbortController();
    abort.abort();
    await answerer.answer(req(), abort.signal);
    expect(cache.store.size).toBe(0);
  });

  it('normalizes questions for the cache key', () => {
    expect(normalizeForCache('  What IS  the rollback command?? ')).toBe('what is the rollback command');
  });

  describe('multi-turn chat (query condensation)', () => {
    const history: HistoryMessage[] = [
      { role: 'user', content: 'How long does Nimbus keep messages?' },
      { role: 'assistant', content: '72 hours [1].' },
    ];
    const standalone = 'How long does the Nimbus telemetry.raw topic keep messages?';

    it('retrieves and prompts with the standalone question, and says so in an event', async () => {
      const condenser = fakeCondenser({ 'and the raw topic?': standalone });
      const { answerer, retriever } = setup(undefined, 2, condenser);
      const events: AnswerEvent[] = [];
      for await (const e of answerer.stream({ ...req('and the raw topic?'), history })) events.push(e);

      expect(events[0]).toEqual({ type: 'condensed', question: standalone });
      expect(vi.mocked(retriever.retrieve).mock.calls[0]![0].query).toBe(standalone);
      const done = (events.at(-1) as Extract<AnswerEvent, { type: 'done' }>).result;
      expect(done.condensedQuestion).toBe(standalone);
      expect(done.timings).toHaveProperty('condense');
      expect(done.usage).toEqual({ promptTokens: 160, completionTokens: 13 }); // answer + condensation tokens
    });

    it('never calls the condenser on a first question', async () => {
      const condenser = fakeCondenser({});
      const { answerer } = setup(undefined, 2, condenser);
      const result = await answerer.answer(req());
      expect(condenser.calls).toBe(0);
      expect(result.condensedQuestion).toBeNull();
    });

    it('keys the answer cache on the standalone question', async () => {
      const condenser = fakeCondenser({ 'and the raw topic?': standalone });
      const { answerer, llm } = setup(undefined, 2, condenser);
      await answerer.answer({ ...req('and the raw topic?'), history });
      // Asked directly as a standalone question: same answer, served from cache.
      const direct = await answerer.answer(req(standalone));
      expect(direct.cached).toBe(true);
      expect(llm.calls).toBe(1);
    });

    it('ignores history when no condenser is configured', async () => {
      const { answerer, retriever } = setup();
      await answerer.answer({ ...req('and the raw topic?'), history });
      expect(vi.mocked(retriever.retrieve).mock.calls[0]![0].query).toBe('and the raw topic?');
    });
  });
});
