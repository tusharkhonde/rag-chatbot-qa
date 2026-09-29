import type { FastifyPluginAsync } from 'fastify';
import type { Repo } from '../db/repo.js';
import { MlClientError, type MlClient } from '../ml/client.js';

interface Deps {
  repo: Repo;
  ml: MlClient;
}

const collectionParams = {
  type: 'object',
  required: ['collectionId'],
  properties: { collectionId: { type: 'string', format: 'uuid' } },
} as const;

export const collectionRoutes: FastifyPluginAsync<Deps> = async (app, { repo, ml }) => {
  app.post<{ Body: { name: string } }>(
    '/collections',
    {
      config: { scope: 'documents:write' },
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: { name: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[\\w .-]+$' } },
        },
      },
    },
    async (req, reply) => {
      const collection = await repo.createCollection(req.clientId, req.body.name);
      if (!collection) return reply.code(409).send({ error: 'Collection name already exists' });
      return reply.code(201).send(collection);
    },
  );

  app.get('/collections', { config: { scope: 'query' } }, async (req) => ({
    collections: await repo.listCollections(req.clientId),
  }));

  app.get<{ Params: { collectionId: string } }>(
    '/collections/:collectionId/documents',
    { config: { scope: 'query' }, schema: { params: collectionParams } },
    async (req, reply) => {
      const collection = await repo.getCollection(req.clientId, req.params.collectionId);
      if (!collection) return reply.code(404).send({ error: 'Collection not found' });
      return { documents: await repo.listDocuments(req.clientId, collection.id) };
    },
  );

  app.post<{ Params: { collectionId: string } }>(
    '/collections/:collectionId/documents',
    { config: { scope: 'documents:write' }, schema: { params: collectionParams } },
    async (req, reply) => {
      // Ownership is checked HERE, before the file goes anywhere. The ml service trusts
      // the collection id it's given, so this check is the tenancy boundary.
      const collection = await repo.getCollection(req.clientId, req.params.collectionId);
      if (!collection) return reply.code(404).send({ error: 'Collection not found' });

      const file = await req.file();
      if (!file) return reply.code(400).send({ error: 'Expected a multipart "file" field' });
      // Buffered (bounded by the multipart fileSize limit) rather than streamed: simpler, and
      // the ml service needs the whole file anyway to hash it before doing any work.
      const data = await file.toBuffer();

      try {
        const result = await ml.ingest(req.clientId, collection.id, { filename: file.filename, mimeType: file.mimetype, data });
        return reply.code(result.created ? 201 : 200).send({
          documentId: result.document_id,
          created: result.created,
          chunkCount: result.chunk_count,
        });
      } catch (err) {
        if (err instanceof MlClientError) return reply.code(err.statusCode).send({ error: err.message });
        throw err;
      }
    },
  );

  app.get<{ Params: { chunkId: string } }>(
    '/chunks/:chunkId',
    {
      config: { scope: 'query' },
      schema: { params: { type: 'object', required: ['chunkId'], properties: { chunkId: { type: 'string', format: 'uuid' } } } },
    },
    async (req, reply) => {
      const chunk = await repo.getChunk(req.clientId, req.params.chunkId);
      return chunk ?? reply.code(404).send({ error: 'Chunk not found' });
    },
  );
};
