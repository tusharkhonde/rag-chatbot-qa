/**
 * MCP server over stdio: the MCP host (Claude Code, Claude Desktop, MCP Inspector...) launches this
 * process and exchanges JSON-RPC messages over stdin/stdout.
 *
 *   RAG_CLIENT_ID=... RAG_CLIENT_SECRET=... node dist/mcp/stdio.js
 *
 * stdout IS the protocol channel: anything else printed there corrupts the stream, so all
 * diagnostics go to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { httpBackend } from './httpBackend.js';
import { createRagMcpServer } from './server.js';

const clientId = process.env.RAG_CLIENT_ID;
const clientSecret = process.env.RAG_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('RAG_CLIENT_ID and RAG_CLIENT_SECRET are required (create a client with dist/cli/create-client.js)');
  process.exit(2);
}

// 127.0.0.1, not localhost: inside Alpine, localhost resolves to IPv6 ::1 first.
const baseUrl = process.env.RAG_API_URL ?? 'http://127.0.0.1:3000';
const server = createRagMcpServer(httpBackend({ baseUrl, clientId, clientSecret }));
await server.connect(new StdioServerTransport());
console.error(`rag-docs MCP server ready on stdio (API: ${baseUrl})`);
