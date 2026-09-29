import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { createPool } from '../../src/db/pool.js';
import { createRepo } from '../../src/db/repo.js';
import { createSearchStore, toPgVector } from '../../src/retrieval/search.js';

const pool = createPool(process.env.DATABASE_URL ?? 'postgresql://rag:rag@localhost:5432/rag');
const store = createSearchStore(pool, 100);
const DIM = 768;

/** Unit vector pointing mostly along axis `i`, slightly toward axis `j`: controls nearest-neighbour order. */
function vec(i: number, j = i, mix = 0): number[] {
  const v = new Array(DIM).fill(0);
  v[i] = 1 - mix;
  v[j] += mix;
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

let clientId: string;
let collectionA: string;
let collectionB: string;

async function seedCollection(name: string, chunks: { content: string; embedding: number[]; model?: string }[]) {
  const { rows: [col] } = await pool.query(`INSERT INTO collections (client_id, name) VALUES ($1, $2) RETURNING id`, [clientId, name]);
  const { rows: [doc] } = await pool.query(
    `INSERT INTO documents (collection_id, filename, mime_type, sha256, status, chunk_count)
     VALUES ($1, $2, 'text/markdown', md5(random()::text), 'ready', $3) RETURNING id`,
    [col.id, `${name}.md`, chunks.length],
  );
  for (const [i, c] of chunks.entries()) {
    await pool.query(
      `INSERT INTO chunks (document_id, collection_id, ordinal, content, token_count, metadata, embedding, embedding_model)
       VALUES ($1, $2, $3, $4, 10, '{}', $5::vector, $6)`,
      [doc.id, col.id, i, c.content, toPgVector(c.embedding), c.model ?? 'ollama:test'],
    );
  }
  return col.id as string;
}

beforeAll(async () => {
  await migrate(pool, new URL('../../../../db/migrations', import.meta.url).pathname);
  const { rows: [client] } = await pool.query(
    `INSERT INTO clients (client_id, secret_hash, name) VALUES ('it-search-' || gen_random_uuid(), 'x', 'search test') RETURNING id`,
  );
  clientId = client.id;
  collectionA = await seedCollection('a', [
    { content: 'Rollbacks are done with the launchpad rollback command.', embedding: vec(0) },
    { content: 'Canary releases start at five percent of stations.', embedding: vec(0, 1, 0.4) },
    { content: 'On-call rotation starts on Wednesday.', embedding: vec(2) },
  ]);
  // Collection B holds the vector closest to every query below: it must never leak into A's results.
  collectionB = await seedCollection('b', [{ content: 'Rollbacks rollback rollback (other tenant).', embedding: vec(0) }]);
});

afterAll(async () => {
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]); // cascades to collections/documents/chunks
  await pool.end();
});

describe('vectorSearch', () => {
  it('orders by cosine similarity and reports it as the score', async () => {
    const hits = await store.vectorSearch(clientId, collectionA, vec(0), 3);
    expect(hits.map((h) => h.content.split(' ')[0])).toEqual(['Rollbacks', 'Canary', 'On-call']);
    expect(hits[0]!.vectorScore).toBeCloseTo(1, 5);
    expect(hits[2]!.vectorScore).toBeCloseTo(0, 5);
  });

  it('only returns chunks from the requested collection', async () => {
    const hits = await store.vectorSearch(clientId, collectionA, vec(0), 10);
    expect(hits).toHaveLength(3);
    expect(hits.every((h) => !h.content.includes('other tenant'))).toBe(true);
  });
});

describe('keywordSearch', () => {
  it('uses OR semantics with stemming, so natural questions match', async () => {
    // "rolled" stems to "roll"; "percent" is unrelated to the top chunk. With AND semantics
    // (plainto_tsquery) this question would match nothing.
    const hits = await store.keywordSearch(clientId, collectionA, 'how are releases rolled back?', 5);
    expect(hits.map((h) => h.content.split(' ')[0])).toEqual(expect.arrayContaining(['Canary']));
    expect(hits.every((h) => !h.content.includes('other tenant'))).toBe(true);
  });

  it('returns nothing for a query made only of stopwords', async () => {
    expect(await store.keywordSearch(clientId, collectionA, 'what is the', 5)).toEqual([]);
  });
});

describe('foreignEmbeddingModel', () => {
  it('detects chunks embedded with a different model', async () => {
    expect(await store.foreignEmbeddingModel(clientId, collectionA, 'ollama:test')).toBeNull();
    expect(await store.foreignEmbeddingModel(clientId, collectionA, 'openai:other')).toBe('ollama:test');
  });
});

describe('repo.getChunk (MCP chunk resource)', () => {
  it("returns a chunk to its owner and nothing to another tenant", async () => {
    const repo = createRepo(pool);
    const [hit] = await store.vectorSearch(clientId, collectionA, vec(0), 1);
    const chunk = await repo.getChunk(clientId, hit!.chunkId);
    expect(chunk).toMatchObject({ chunkId: hit!.chunkId, filename: 'a.md', content: hit!.content });

    const { rows: [other] } = await pool.query(
      `INSERT INTO clients (client_id, secret_hash, name) VALUES ('it-other-' || gen_random_uuid(), 'x', 'other') RETURNING id`,
    );
    try {
      expect(await repo.getChunk(other.id, hit!.chunkId)).toBeNull();
    } finally {
      await pool.query('DELETE FROM clients WHERE id = $1', [other.id]);
    }
  });
});
