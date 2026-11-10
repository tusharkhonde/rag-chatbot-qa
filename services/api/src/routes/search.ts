import type { FastifyPluginAsync } from 'fastify';
import type { Repo } from '../db/repo.js';
import type { Condenser, HistoryMessage } from '../generation/condense.js';
import type { Metrics } from '../observability/metrics.js';
import { EmbeddingModelMismatchError, type Retriever } from '../retrieval/retriever.js';
import type { RetrievalMode } from '../retrieval/types.js';

interface Deps {
  repo: Repo;
  retriever: Retriever;
  defaults: { mode: RetrievalMode; topK: number };
  metrics: Metrics;
  condenser?: Condenser;
}

export const searchBodySchema = {
  query: { type: 'string', minLength: 1, maxLength: 1000 },
  topK: { type: 'integer', minimum: 1, maximum: 20 },
  mode: { type: 'string', enum: ['hybrid', 'vector', 'keyword'] },
} as const;

/** Earlier chat turns, oldest first. Bounded: the condenser only reads the last few anyway. */
export const historySchema = {
  type: 'array',
  maxItems: 20,
  items: {
    type: 'object',
    required: ['role', 'content'],
    additionalProperties: false,
    properties: {
      role: { type: 'string', enum: ['user', 'assistant'] },
      content: { type: 'string', minLength: 1, maxLength: 4000 },
    },
  },
} as const;

/** Retrieval only, no generation: for debugging relevance and for the offline eval harness. */
export const searchRoutes: FastifyPluginAsync<Deps> = async (app, { repo, retriever, defaults, metrics, condenser }) => {
  app.post<{
    Params: { collectionId: string };
    Body: { query: string; topK?: number; mode?: RetrievalMode; history?: HistoryMessage[] };
  }>(
    '/collections/:collectionId/search',
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
          required: ['query'],
          additionalProperties: false,
          properties: { ...searchBodySchema, history: historySchema },
        },
      },
    },
    async (req, reply) => {
      const collection = await repo.getCollection(req.clientId, req.params.collectionId);
      if (!collection) return reply.code(404).send({ error: 'Collection not found' });
      try {
        // Same condensation as /query, so retrieval for a chat follow-up can be inspected (and evaluated).
        let query = req.body.query;
        let condensedQuery: string | null = null;
        if (condenser && req.body.history?.length) {
          const condensed = await condenser.condense(req.body.history, query);
          if (condensed.condensed) query = condensedQuery = condensed.question;
        }
        const result = await retriever.retrieve({
          clientId: req.clientId,
          collectionId: collection.id,
          query,
          mode: req.body.mode ?? defaults.mode,
          topK: req.body.topK ?? defaults.topK,
        });
        metrics.observeRetrieval(result);
        req.log.info(
          {
            event: 'rag_search', collectionId: collection.id, mode: result.mode, results: result.chunks.length,
            topVectorScore: result.topVectorScore, hit: metrics.isHit(result), embeddingCached: result.embeddingCached,
            timings: result.timings,
          },
          'search',
        );
        return { ...result, condensedQuery };
      } catch (err) {
        if (err instanceof EmbeddingModelMismatchError) return reply.code(409).send({ error: err.message });
        throw err;
      }
    },
  );
};
