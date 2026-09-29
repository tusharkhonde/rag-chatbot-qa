import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyPluginAsync } from 'fastify';
import type { Repo } from '../db/repo.js';
import type { Answerer } from '../generation/answerer.js';
import { inProcessBackend } from '../mcp/backend.js';
import { createRagMcpServer } from '../mcp/server.js';
import type { Retriever } from '../retrieval/retriever.js';
import type { RetrievalMode } from '../retrieval/types.js';

interface Deps {
  repo: Repo;
  retriever: Retriever;
  answerer: Answerer;
  defaults: { mode: RetrievalMode; topK: number };
}

/**
 * MCP over Streamable HTTP, stateless mode: every POST is a self-contained JSON-RPC exchange with
 * a fresh server bound to the caller's tenant. No session state means any API replica can serve
 * any request (no sticky sessions), at the cost of server-initiated messages between requests,
 * which these read-only tools don't need. Authentication and scope checks run in the enclosing
 * plugin's hooks before this handler, exactly like the REST routes.
 */
export const mcpRoutes: FastifyPluginAsync<Deps> = async (app, deps) => {
  app.post('/mcp', { config: { scope: 'query' } }, async (req, reply) => {
    const server = createRagMcpServer(inProcessBackend(req.clientId, deps));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true, // plain JSON responses instead of an SSE stream per request
    });
    reply.hijack(); // the SDK writes the raw Node response itself
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  // GET (server→client SSE stream) and DELETE (end session) only exist for stateful sessions.
  const notAllowed = { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server)' }, id: null };
  app.get('/mcp', { config: { scope: 'query' } }, async (_req, reply) => reply.code(405).header('allow', 'POST').send(notAllowed));
  app.delete('/mcp', { config: { scope: 'query' } }, async (_req, reply) => reply.code(405).header('allow', 'POST').send(notAllowed));
};
