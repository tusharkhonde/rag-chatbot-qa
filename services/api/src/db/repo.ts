import type pg from 'pg';
import { withTenant } from './tenant.js';

export interface Collection {
  id: string;
  name: string;
  version: number;
  createdAt: string;
}

export interface DocumentSummary {
  id: string;
  filename: string;
  mimeType: string;
  status: string;
  chunkCount: number;
  createdAt: string;
}

export interface ChunkDetail {
  chunkId: string;
  documentId: string;
  collectionId: string;
  filename: string;
  ordinal: number;
  content: string;
  metadata: import('../retrieval/types.js').ChunkMetadata;
}

// Every method takes the tenant (clientId), filters by it in SQL, AND runs under Row-Level
// Security for that tenant (withTenant). A collection owned by another client is
// indistinguishable from one that doesn't exist: callers get null → 404.
export interface Repo {
  createCollection(clientId: string, name: string): Promise<Collection | null>;
  listCollections(clientId: string): Promise<Collection[]>;
  getCollection(clientId: string, collectionId: string): Promise<Collection | null>;
  listDocuments(clientId: string, collectionId: string): Promise<DocumentSummary[]>;
  getChunk(clientId: string, chunkId: string): Promise<ChunkDetail | null>;
}

const COLLECTION_COLUMNS = `id, name, version, created_at AS "createdAt"`;

export function createRepo(pool: pg.Pool): Repo {
  return {
    async createCollection(clientId, name) {
      const { rows } = await withTenant(pool, clientId, (db) => db.query<Collection>(
        `INSERT INTO collections (client_id, name) VALUES ($1, $2)
         ON CONFLICT (client_id, name) DO NOTHING
         RETURNING ${COLLECTION_COLUMNS}`,
        [clientId, name],
      ));
      return rows[0] ?? null; // null = name already taken by this client
    },

    async listCollections(clientId) {
      const { rows } = await withTenant(pool, clientId, (db) => db.query<Collection>(
        `SELECT ${COLLECTION_COLUMNS} FROM collections WHERE client_id = $1 ORDER BY created_at`,
        [clientId],
      ));
      return rows;
    },

    async getCollection(clientId, collectionId) {
      const { rows } = await withTenant(pool, clientId, (db) => db.query<Collection>(
        `SELECT ${COLLECTION_COLUMNS} FROM collections WHERE id = $1 AND client_id = $2`,
        [collectionId, clientId],
      ));
      return rows[0] ?? null;
    },

    async listDocuments(clientId, collectionId) {
      const { rows } = await withTenant(pool, clientId, (db) => db.query<DocumentSummary>(
        `SELECT d.id, d.filename, d.mime_type AS "mimeType", d.status,
                d.chunk_count AS "chunkCount", d.created_at AS "createdAt"
           FROM documents d
           JOIN collections c ON c.id = d.collection_id
          WHERE d.collection_id = $1 AND c.client_id = $2
          ORDER BY d.created_at`,
        [collectionId, clientId],
      ));
      return rows;
    },

    async getChunk(clientId, chunkId) {
      const { rows } = await withTenant(pool, clientId, (db) => db.query<ChunkDetail>(
        `SELECT c.id AS "chunkId", c.document_id AS "documentId", c.collection_id AS "collectionId",
                d.filename, c.ordinal, c.content, c.metadata
           FROM chunks c
           JOIN documents d ON d.id = c.document_id
           JOIN collections co ON co.id = c.collection_id
          WHERE c.id = $1 AND co.client_id = $2`,
        [chunkId, clientId],
      ));
      return rows[0] ?? null;
    },
  };
}
