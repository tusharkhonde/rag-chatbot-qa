import { createHash } from 'node:crypto';
import type { Cache } from '../cache/cache.js';
import type { Collection } from '../db/repo.js';
import type { Retriever } from '../retrieval/retriever.js';
import type { RetrievalMode } from '../retrieval/types.js';
import { extractCitations, isRefusal, type Citation } from './citations.js';
import type { Condenser, HistoryMessage } from './condense.js';
import type { LlmClient, Usage } from './llm.js';
import { buildPrompt, PROMPT_VERSION, REFUSAL, type Source } from './prompt.js';

export interface SourceInfo {
  index: number;
  label: string;
  chunkId: string;
  documentId: string;
  filename: string;
  score: number;
  vectorScore?: number;
  keywordScore?: number;
}

export interface AnswerResult {
  answer: string;
  citations: Citation[];
  /** [n] markers the model produced that match no provided source (hallucinated citations). */
  invalidCitations: number[];
  sources: SourceInfo[];
  refused: boolean;
  cached: boolean;
  /** The standalone question used for retrieval when a follow-up was rewritten, else null. */
  condensedQuestion: string | null;
  model: string;
  usage: Usage | null;
  retrieval: { mode: RetrievalMode; topVectorScore: number | null; embeddingCached: boolean | null };
  timings: Record<string, number>;
}

export type AnswerEvent =
  | { type: 'condensed'; question: string }
  | { type: 'sources'; sources: SourceInfo[] }
  | { type: 'delta'; text: string }
  | { type: 'done'; result: AnswerResult };

export interface AnswerRequest {
  clientId: string;
  collection: Collection;
  question: string;
  /** Earlier turns of a chat, oldest first. A follow-up is rewritten into a standalone question. */
  history?: HistoryMessage[];
  mode: RetrievalMode;
  topK: number;
}

export interface Answerer {
  stream(req: AnswerRequest, signal?: AbortSignal): AsyncGenerator<AnswerEvent>;
  answer(req: AnswerRequest, signal?: AbortSignal): Promise<AnswerResult>;
}

interface Deps {
  retriever: Retriever;
  llm: LlmClient;
  cache: Cache;
  embeddingModelId: () => Promise<string>;
  maxContextTokens: number;
  cacheTtlSeconds: number;
  /** Rewrites follow-ups using the history. Without it, history is ignored. */
  condenser?: Condenser;
}

const addUsage = (a: Usage | null, b: Usage | null): Usage | null =>
  a && b ? { promptTokens: a.promptTokens + b.promptTokens, completionTokens: a.completionTokens + b.completionTokens } : (a ?? b);

/** "What's the rollback command?" and "what's the rollback command" should share a cache entry. */
export const normalizeForCache = (q: string) =>
  q.toLowerCase().trim().replace(/\s+/g, ' ').replace(/[?.!]+$/, '');

const toInfo = (s: Source): SourceInfo => ({
  index: s.index,
  label: s.label,
  chunkId: s.chunk.chunkId,
  documentId: s.chunk.documentId,
  filename: s.chunk.filename,
  score: s.chunk.score,
  vectorScore: s.chunk.vectorScore,
  keywordScore: s.chunk.keywordScore,
});

const ms = (start: number) => Math.round((performance.now() - start) * 10) / 10;

export function createAnswerer(deps: Deps): Answerer {
  async function cacheKey(req: AnswerRequest, question: string): Promise<string> {
    // Everything that can change the answer is in the key:
    //  - clientId: tenant isolation (never serve one tenant's answer to another)
    //  - collection.version: bumped on every ingest, so new documents invalidate old answers
    //  - models + retrieval params + prompt version: a config change must not serve stale answers
    const parts = [
      req.clientId,
      req.collection.id,
      req.collection.version,
      // The standalone question: two different conversations that lead to the same question
      // share an answer, and the same words in different conversations don't.
      normalizeForCache(question),
      deps.llm.model,
      await deps.embeddingModelId(),
      req.mode,
      req.topK,
      PROMPT_VERSION,
    ];
    return `ans:${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
  }

  async function* stream(req: AnswerRequest, signal?: AbortSignal): AsyncGenerator<AnswerEvent> {
    const start = performance.now();
    const pre: Record<string, number> = {};

    // Follow-up in a chat: rewrite it into a standalone question before anything else uses it.
    let question = req.question;
    let condensedQuestion: string | null = null;
    let condenseUsage: Usage | null = null;
    if (deps.condenser && req.history?.length) {
      const condenseStart = performance.now();
      const condensed = await deps.condenser.condense(req.history, req.question, signal);
      pre.condense = ms(condenseStart);
      condenseUsage = condensed.usage;
      if (condensed.condensed) {
        question = condensed.question;
        condensedQuestion = question;
        yield { type: 'condensed', question };
      }
    }

    const key = await cacheKey(req, question);
    const hit = await deps.cache.get(key);
    if (hit) {
      const cached = JSON.parse(hit) as AnswerResult;
      yield { type: 'sources', sources: cached.sources };
      yield { type: 'delta', text: cached.answer };
      yield {
        type: 'done',
        result: { ...cached, cached: true, condensedQuestion, usage: condenseUsage, timings: { ...pre, total: ms(start) } },
      };
      return;
    }

    const retrieval = await deps.retriever.retrieve({
      clientId: req.clientId,
      collectionId: req.collection.id,
      query: question,
      mode: req.mode,
      topK: req.topK,
    });
    const timings: Record<string, number> = { ...pre, ...retrieval.timings };
    const base = {
      cached: false,
      condensedQuestion,
      model: deps.llm.model,
      retrieval: {
        mode: retrieval.mode,
        topVectorScore: retrieval.topVectorScore,
        embeddingCached: retrieval.embeddingCached,
      },
    };

    // Nothing retrieved: answering would be pure hallucination, so don't call the LLM at all.
    if (retrieval.chunks.length === 0) {
      const result: AnswerResult = {
        ...base, answer: REFUSAL, citations: [], invalidCitations: [], sources: [], refused: true, usage: condenseUsage,
        timings: { ...timings, total: ms(start) },
      };
      yield { type: 'sources', sources: [] };
      yield { type: 'delta', text: REFUSAL };
      yield { type: 'done', result };
      return;
    }

    const { messages, sources } = buildPrompt(question, retrieval.chunks, deps.maxContextTokens);
    const sourceInfo = sources.map(toInfo);
    // Sources go out before generation starts: a UI can show them while the answer streams in.
    yield { type: 'sources', sources: sourceInfo };

    let answer = '';
    let usage: Usage | null = null;
    const genStart = performance.now();
    for await (const event of deps.llm.stream(messages, signal)) {
      if (event.type === 'delta') {
        if (!answer) timings.ttft = ms(genStart); // time to first token: the latency users feel
        answer += event.text;
        yield event;
      } else {
        usage = event.usage;
      }
    }
    timings.generate = ms(genStart);

    const { citations, invalid } = extractCitations(answer, sources);
    const result: AnswerResult = {
      ...base,
      answer: answer.trim(),
      citations,
      invalidCitations: invalid,
      sources: sourceInfo,
      refused: isRefusal(answer),
      usage: addUsage(usage, condenseUsage), // every LLM token this answer cost
      timings,
    };
    // Never cache a partial answer from a client that disconnected mid-stream.
    if (!signal?.aborted) {
      const { timings: _t, ...cacheable } = result;
      await deps.cache.set(key, JSON.stringify(cacheable), deps.cacheTtlSeconds);
    }
    timings.total = ms(start);
    yield { type: 'done', result };
  }

  return {
    stream,
    async answer(req, signal) {
      for await (const event of stream(req, signal)) {
        if (event.type === 'done') return event.result;
      }
      throw new Error('answer stream ended without a result');
    },
  };
}
