import type { Citation } from '../generation/citations.js';
import type { Answerer } from '../generation/answerer.js';
import type { ChunkDetail, Collection, DocumentSummary, Repo } from '../db/repo.js';
import type { Retriever } from '../retrieval/retriever.js';
import type { RetrievalMode, RetrievedChunk } from '../retrieval/types.js';

/**
 * Everything the MCP server needs from the RAG system, for ONE already-authenticated tenant.
 *
 * This "port" lets the same MCP server definition run behind two transports:
 *  - Streamable HTTP inside the API → inProcessBackend (calls repo/retriever/answerer directly)
 *  - stdio as a local subprocess    → httpBackend (calls the REST API with its own credentials)
 */
export interface RagBackend {
  listCollections(): Promise<Collection[]>;
  listDocuments(collectionId: string): Promise<DocumentSummary[]>;
  search(collectionId: string, query: string, opts: { topK: number; mode: RetrievalMode }): Promise<{ mode: RetrievalMode; chunks: RetrievedChunk[] }>;
  ask(collectionId: string, question: string): Promise<{ answer: string; refused: boolean; citations: Citation[] }>;
  getChunk(chunkId: string): Promise<ChunkDetail | null>;
}

export class NotFoundError extends Error {}

export function inProcessBackend(
  clientId: string,
  deps: { repo: Repo; retriever: Retriever; answerer: Answerer; defaults: { mode: RetrievalMode; topK: number } },
): RagBackend {
  const { repo, retriever, answerer, defaults } = deps;
  const owned = async (collectionId: string) => {
    const collection = await repo.getCollection(clientId, collectionId);
    if (!collection) throw new NotFoundError('Collection not found');
    return collection;
  };
  return {
    listCollections: () => repo.listCollections(clientId),
    listDocuments: async (collectionId) => repo.listDocuments(clientId, (await owned(collectionId)).id),
    search: async (collectionId, query, opts) =>
      retriever.retrieve({ clientId, collectionId: (await owned(collectionId)).id, query, ...opts }),
    ask: async (collectionId, question) =>
      answerer.answer({ clientId, collection: await owned(collectionId), question, mode: defaults.mode, topK: defaults.topK }),
    getChunk: (chunkId) => repo.getChunk(clientId, chunkId),
  };
}
