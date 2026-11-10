import type { FastifyPluginAsync } from 'fastify';
import type { Repo } from '../db/repo.js';
import type { AnswerResult, Answerer } from '../generation/answerer.js';
import type { Metrics } from '../observability/metrics.js';
import { EmbeddingModelMismatchError } from '../retrieval/retriever.js';
import type { RetrievalMode } from '../retrieval/types.js';
import type { HistoryMessage } from '../generation/condense.js';
import { historySchema, searchBodySchema } from './search.js';

interface Deps {
  repo: Repo;
  answerer: Answerer;
  defaults: { mode: RetrievalMode; topK: number };
  metrics: Metrics;
}

interface QueryBody {
  question: string;
  history?: HistoryMessage[];
  topK?: number;
  mode?: RetrievalMode;
  stream?: boolean;
}

export const queryRoutes: FastifyPluginAsync<Deps> = async (app, { repo, answerer, defaults, metrics }) => {
  // One structured line per answered question: everything needed to debug quality or latency
  // (stage timings, token usage, cache, retrieval confidence) without logging the question text.
  function record(log: typeof app.log, collectionId: string, result: AnswerResult, streamed: boolean, userId?: string) {
    metrics.observeAnswer(result);
    log.info(
      {
        event: 'rag_query', collectionId, userId, streamed, cached: result.cached, refused: result.refused,
        mode: result.retrieval.mode, condensed: result.condensedQuestion !== null,
        sources: result.sources.length, citations: result.citations.length,
        invalidCitations: result.invalidCitations, topVectorScore: result.retrieval.topVectorScore,
        usage: result.usage, timings: result.timings, model: result.model,
      },
      'rag query',
    );
  }

  app.post<{ Params: { collectionId: string }; Body: QueryBody }>(
    '/collections/:collectionId/query',
    {
      config: { scope: 'query' },
      schema: {
        params: {
          type: 'object',
          required: ['collectionId'],
          properties: { collectionId: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          required: ['question'],
          additionalProperties: false,
          properties: {
            question: searchBodySchema.query,
            history: historySchema,
            topK: searchBodySchema.topK,
            mode: searchBodySchema.mode,
            stream: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      const collection = await repo.getCollection(req.clientId, req.params.collectionId);
      if (!collection) return reply.code(404).send({ error: 'Collection not found' });

      const request = {
        clientId: req.clientId,
        collection,
        question: req.body.question,
        history: req.body.history,
        mode: req.body.mode ?? defaults.mode,
        topK: req.body.topK ?? defaults.topK,
      };

      if (!req.body.stream) {
        try {
          const result = await answerer.answer(request);
          record(req.log, collection.id, result, false, req.userId);
          return result;
        } catch (err) {
          if (err instanceof EmbeddingModelMismatchError) return reply.code(409).send({ error: err.message });
          throw err;
        }
      }

      // Server-Sent Events: one-way server→client stream over plain HTTP. Simpler than WebSockets
      // (no upgrade, works through proxies, auto-reconnect in browsers' EventSource) and a natural
      // fit for token streaming. We write to the raw response, so Fastify stops managing it.
      const started = performance.now();
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no', // stop nginx-style proxies from buffering the stream
        'x-request-id': req.id,
      });
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      // If the client disconnects, abort the LLM call instead of generating tokens nobody reads.
      const abort = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) abort.abort();
      });

      try {
        for await (const event of answerer.stream(request, abort.signal)) {
          if (event.type === 'delta') send('delta', { text: event.text });
          else if (event.type === 'sources') send('sources', { sources: event.sources });
          else if (event.type === 'condensed') send('condensed', { question: event.question });
          else {
            record(req.log, collection.id, event.result, true, req.userId);
            send('done', event.result);
          }
        }
      } catch (err) {
        if (!abort.signal.aborted) {
          req.log.error({ err }, 'streaming answer failed');
          const message = err instanceof EmbeddingModelMismatchError ? err.message : 'Answer generation failed';
          send('error', { error: message });
        }
      } finally {
        res.end();
        // Hijacked responses skip Fastify's onResponse hook, so record HTTP latency here.
        metrics.httpDuration.observe(
          { method: 'POST', route: req.routeOptions.url ?? 'unmatched', status_code: 200 },
          (performance.now() - started) / 1000,
        );
      }
    },
  );
};
