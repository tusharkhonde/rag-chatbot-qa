import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClientStore } from '../../src/auth/clients.js';
import { migrate } from '../../src/db/migrate.js';
import { createPool } from '../../src/db/pool.js';
import { createRepo } from '../../src/db/repo.js';
import { withTenant } from '../../src/db/tenant.js';

const pool = createPool(process.env.DATABASE_URL ?? 'postgresql://rag:rag@localhost:5432/rag');
const repo = createRepo(pool);
const clients = createClientStore(pool);
const ids: string[] = [];
let tenantA: string;
let tenantB: string;
let secretA: string;
let publicA: string;

beforeAll(async () => {
  await migrate(pool, new URL('../../../../db/migrations', import.meta.url).pathname);
  const a = await clients.create('tenant A', ['query']);
  const b = await clients.create('tenant B', ['query']);
  secretA = a.clientSecret;
  publicA = a.clientId;
  const { rows } = await pool.query(`SELECT id, client_id FROM clients WHERE client_id = ANY($1)`, [[a.clientId, b.clientId]]);
  tenantA = rows.find((r) => r.client_id === a.clientId).id;
  tenantB = rows.find((r) => r.client_id === b.clientId).id;
  ids.push(tenantA, tenantB);
  await repo.createCollection(tenantA, 'a-docs');
  await repo.createCollection(tenantB, 'b-docs');
});

afterAll(async () => {
  await pool.query('DELETE FROM clients WHERE id = ANY($1)', [ids]);
  await pool.end();
});

describe('client credentials store', () => {
  it('stores an argon2id hash, never the secret, and authenticates with it', async () => {
    const { rows } = await pool.query('SELECT secret_hash FROM clients WHERE id = $1', [tenantA]);
    expect(rows[0].secret_hash).toMatch(/^\$argon2id\$/);
    expect(rows[0].secret_hash).not.toContain(secretA);
    expect(await clients.authenticate(publicA, secretA)).toMatchObject({ clientId: tenantA, scopes: ['query'] });
    expect(await clients.authenticate(publicA, 'wrong')).toBeNull();
    expect(await clients.authenticate('rag_nope', secretA)).toBeNull();
  });
});

describe('row-level security', () => {
  it("hides other tenants' rows even from a query with no WHERE clause", async () => {
    const names = await withTenant(pool, tenantA, async (db) => (await db.query('SELECT name FROM collections')).rows);
    expect(names.map((r) => r.name)).toEqual(['a-docs']);
  });

  it("returns nothing for another tenant's collection id (even when asked directly)", async () => {
    const [bCollection] = await repo.listCollections(tenantB);
    expect(await repo.getCollection(tenantA, bCollection!.id)).toBeNull();
    const rows = await withTenant(pool, tenantA, async (db) =>
      (await db.query('SELECT id FROM collections WHERE id = $1', [bCollection!.id])).rows);
    expect(rows).toEqual([]);
  });

  it("blocks writing a row that belongs to another tenant (WITH CHECK)", async () => {
    await expect(
      withTenant(pool, tenantA, (db) => db.query(`INSERT INTO collections (client_id, name) VALUES ($1, 'sneaky')`, [tenantB])),
    ).rejects.toThrow(/row-level security/);
  });

  it('denies tenant-scoped code any access to the credentials table', async () => {
    await expect(withTenant(pool, tenantA, (db) => db.query('SELECT secret_hash FROM clients'))).rejects.toThrow(/permission denied/);
  });

  it('fails closed when no tenant is set', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE rag_app');
      expect((await client.query('SELECT count(*)::int AS n FROM collections')).rows[0].n).toBe(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});

describe('document deletion', () => {
  async function seedDocument(tenant: string, collectionName: string) {
    const [col] = (await repo.listCollections(tenant)).filter((c) => c.name === collectionName);
    const { rows: [doc] } = await pool.query(
      `INSERT INTO documents (collection_id, filename, mime_type, sha256, status, chunk_count)
       VALUES ($1, 'del.md', 'text/markdown', md5(random()::text), 'ready', 2) RETURNING id`,
      [col!.id],
    );
    for (const ordinal of [0, 1]) {
      await pool.query(
        `INSERT INTO chunks (document_id, collection_id, ordinal, content, token_count, metadata, embedding, embedding_model)
         VALUES ($1, $2, $3, 'text', 1, '{}', array_fill(0.01, ARRAY[768])::vector, 'ollama:test')`,
        [doc.id, col!.id, ordinal],
      );
    }
    return { collection: col!, documentId: doc.id as string };
  }

  it('deletes the document and its chunks, and bumps the collection version', async () => {
    const { collection, documentId } = await seedDocument(tenantA, 'a-docs');
    const before = (await repo.getCollection(tenantA, collection.id))!.version;
    expect(await repo.deleteDocument(tenantA, collection.id, documentId)).toBe(true);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM chunks WHERE document_id = $1', [documentId]);
    expect(rows[0].n).toBe(0);
    expect((await repo.getCollection(tenantA, collection.id))!.version).toBe(before + 1);
    expect(await repo.deleteDocument(tenantA, collection.id, documentId)).toBe(false); // already gone
  });

  it("reads a document's status, and never another tenant's", async () => {
    const { collection, documentId } = await seedDocument(tenantB, 'b-docs');
    expect(await repo.getDocument(tenantB, collection.id, documentId)).toMatchObject({ status: 'ready', error: null, chunkCount: 2 });
    expect(await repo.getDocument(tenantA, collection.id, documentId)).toBeNull();
  });

  it("can't delete another tenant's document, even with the right ids", async () => {
    const { collection, documentId } = await seedDocument(tenantB, 'b-docs');
    const before = (await repo.getCollection(tenantB, collection.id))!.version;
    expect(await repo.deleteDocument(tenantA, collection.id, documentId)).toBe(false);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM documents WHERE id = $1', [documentId]);
    expect(rows[0].n).toBe(1);
    expect((await repo.getCollection(tenantB, collection.id))!.version).toBe(before);
  });

  it('RLS alone stops a cross-tenant DELETE that has no tenant filter', async () => {
    const { documentId } = await seedDocument(tenantB, 'b-docs');
    const deleted = await withTenant(pool, tenantA, async (db) =>
      (await db.query('DELETE FROM documents WHERE id = $1', [documentId])).rowCount);
    expect(deleted).toBe(0);
  });
});
