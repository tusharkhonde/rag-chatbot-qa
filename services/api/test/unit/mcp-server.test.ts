import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RagBackend } from '../../src/mcp/backend.js';
import { createRagMcpServer } from '../../src/mcp/server.js';

const COLLECTION = { id: '11111111-1111-4111-8111-111111111111', name: 'handbook', version: 1, createdAt: '' };
const CHUNK = {
  chunkId: '22222222-2222-4222-8222-222222222222', documentId: 'd1', collectionId: COLLECTION.id,
  filename: 'runbook.md', ordinal: 0, content: 'Messages are retained for 72 hours.',
  metadata: { heading_path: ['Runbook', 'Architecture'] }, score: 0.03,
};

function fakeBackend(): RagBackend {
  return {
    listCollections: vi.fn(async () => [COLLECTION]),
    listDocuments: vi.fn(async () => [{ id: 'd1', filename: 'runbook.md', mimeType: 'text/markdown', status: 'ready', chunkCount: 9, createdAt: '' }]),
    search: vi.fn(async () => ({ mode: 'hybrid' as const, chunks: [CHUNK] })),
    ask: vi.fn(async () => ({
      answer: 'Messages are kept for 72 hours [1].', refused: false,
      citations: [{ index: 1, chunkId: CHUNK.chunkId, documentId: 'd1', filename: 'runbook.md', label: 'runbook.md › Architecture', snippet: '' }],
    })),
    getChunk: vi.fn(async (id) => (id === CHUNK.chunkId ? CHUNK : null)),
  };
}

let client: Client;

/** A real MCP client talking to our server over a linked in-memory transport pair. */
async function connect(backend = fakeBackend()) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createRagMcpServer(backend).connect(serverTransport);
  client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientTransport);
  return { client, backend };
}

afterEach(() => client?.close());

describe('RAG MCP server', () => {
  it('advertises its tools with read-only annotations, plus instructions', async () => {
    await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['ask_question', 'list_collections', 'list_documents', 'search_documents']);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    const search = tools.find((t) => t.name === 'search_documents')!;
    expect(Object.keys(search.inputSchema.properties ?? {})).toEqual(['collection', 'query', 'top_k', 'mode']);
    expect(client.getInstructions()).toContain('list_collections');
  });

  it('search_documents resolves a collection by name and returns delimited excerpts + resource links', async () => {
    const { backend } = await connect();
    const result = await client.callTool({ name: 'search_documents', arguments: { collection: 'Handbook', query: 'retention' } });

    expect(backend.search).toHaveBeenCalledWith(COLLECTION.id, 'retention', { topK: 5, mode: 'hybrid' }); // defaults applied
    const [text, link] = result.content as Array<Record<string, string>>;
    expect(text!.text).toContain('untrusted document content');
    expect(text!.text).toContain('<excerpt n="1" source="runbook.md › Architecture">');
    expect(link).toMatchObject({ type: 'resource_link', uri: `rag://chunks/${CHUNK.chunkId}` });
    expect(result.structuredContent).toEqual({
      results: [{ chunkId: CHUNK.chunkId, source: 'runbook.md › Architecture', score: 0.03, uri: `rag://chunks/${CHUNK.chunkId}` }],
    });
  });

  it('reports an unknown collection as a tool error the model can recover from', async () => {
    const { backend } = await connect();
    const result = await client.callTool({ name: 'search_documents', arguments: { collection: 'nope', query: 'x' } });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]!.text).toBe('Unknown collection "nope". Available collections: "handbook".');
    expect(backend.search).not.toHaveBeenCalled();
  });

  it('rejects invalid arguments via the input schema before any backend call', async () => {
    const { backend } = await connect();
    const result = await client.callTool({ name: 'search_documents', arguments: { collection: 'handbook', query: 'x', top_k: 50 } });
    expect(result.isError).toBe(true);
    expect(backend.search).not.toHaveBeenCalled();
  });

  it('ask_question returns the grounded answer with its sources', async () => {
    await connect();
    const result = await client.callTool({ name: 'ask_question', arguments: { collection: 'handbook', question: 'retention?' } });
    expect((result.content as Array<{ text: string }>)[0]!.text).toBe(
      'Messages are kept for 72 hours [1].\n\nSources:\n[1] runbook.md › Architecture',
    );
    expect(result.structuredContent).toMatchObject({ refused: false, citations: [{ index: 1, chunkId: CHUNK.chunkId }] });
  });

  it('serves chunks through the rag://chunks/{chunkId} resource template', async () => {
    await connect();
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual(['rag://chunks/{chunkId}']);
    const { contents } = await client.readResource({ uri: `rag://chunks/${CHUNK.chunkId}` });
    expect(contents[0]).toMatchObject({ mimeType: 'text/plain', text: 'Source: runbook.md › Architecture\n\nMessages are retained for 72 hours.' });
    await expect(client.readResource({ uri: 'rag://chunks/missing' })).rejects.toThrow(/not found/i);
  });

  it('lists the collections resource and renders the answer_from_docs prompt', async () => {
    await connect();
    const { contents } = await client.readResource({ uri: 'rag://collections' });
    expect(JSON.parse(String(contents[0]!.text))).toEqual([{ id: COLLECTION.id, name: 'handbook' }]);

    const prompt = await client.getPrompt({ name: 'answer_from_docs', arguments: { collection: 'handbook', question: 'How long?' } });
    const text = (prompt.messages[0]!.content as { text: string }).text;
    expect(text).toContain('Call search_documents');
    expect(text.endsWith('Question: How long?')).toBe(true);
  });
});
