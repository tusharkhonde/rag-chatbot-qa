/**
 * Exercise the MCP server as a real MCP client would, over both transports.
 *
 *   RAG_CLIENT_ID=... RAG_CLIENT_SECRET=... node dist/cli/mcp-smoke.js --collection acme-demo --query "rollback"
 *
 * The HTTP run walks the MCP authorization discovery chain explicitly:
 *   401 + WWW-Authenticate resource_metadata → protected-resource metadata (RFC 9728)
 *   → authorization-server metadata (RFC 8414) → token for that resource (RFC 8707) → MCP session.
 */
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

const { values } = parseArgs({
  options: {
    api: { type: 'string', default: process.env.RAG_API_URL ?? 'http://127.0.0.1:3000' },
    transport: { type: 'string', default: 'both' }, // http | stdio | both
    collection: { type: 'string', default: 'acme-demo' },
    query: { type: 'string', default: 'how do I roll back a deploy?' },
  },
});
const clientId = process.env.RAG_CLIENT_ID!;
const clientSecret = process.env.RAG_CLIENT_SECRET!;
const log = (...args: unknown[]) => console.log(...args);

async function discoverAndGetToken(api: string): Promise<{ mcpUrl: string; token: string }> {
  const probe = await fetch(`${api}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list' }),
  });
  const challenge = probe.headers.get('www-authenticate') ?? '';
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
  log(`1. POST /mcp without token → ${probe.status}; WWW-Authenticate: ${challenge}`);
  if (!metadataUrl) throw new Error('no resource_metadata in challenge');

  // The metadata URLs are public (PUBLIC_BASE_URL); rewrite the origin so this also works inside the container.
  const local = (url: string) => url.replace(new URL(url).origin, api);
  const resource = (await (await fetch(local(metadataUrl))).json()) as { resource: string; authorization_servers: string[] };
  log(`2. protected-resource metadata → resource=${resource.resource}, authorization_servers=${resource.authorization_servers}`);

  const as = (await (await fetch(local(`${resource.authorization_servers[0]}/.well-known/oauth-authorization-server`))).json()) as {
    token_endpoint: string;
  };
  log(`3. authorization-server metadata → token_endpoint=${as.token_endpoint}`);

  const tokenRes = await fetch(local(as.token_endpoint), {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'query', resource: resource.resource }).toString(),
  });
  const { access_token } = (await tokenRes.json()) as { access_token: string };
  const aud = JSON.parse(Buffer.from(access_token.split('.')[1]!, 'base64url').toString()).aud;
  log(`4. token for resource=${resource.resource} → ${tokenRes.status}, aud=${aud}`);
  return { mcpUrl: `${api}/mcp`, token: access_token };
}

async function exercise(name: string, transport: Transport) {
  const client = new Client({ name: 'rag-mcp-smoke', version: '1.0.0' });
  await client.connect(transport);
  log(`\n[${name}] connected to ${client.getServerVersion()?.name} ${client.getServerVersion()?.version}`);
  log(`[${name}] tools: ${(await client.listTools()).tools.map((t) => t.name).join(', ')}`);

  const collections = await client.callTool({ name: 'list_collections', arguments: {} });
  log(`[${name}] list_collections →\n${(collections.content as Array<{ text: string }>)[0]!.text}`);

  const search = await client.callTool({ name: 'search_documents', arguments: { collection: values.collection, query: values.query, top_k: 2 } });
  const [text, ...links] = search.content as Array<{ type: string; text?: string; uri?: string; name?: string }>;
  log(`[${name}] search_documents(isError=${search.isError ?? false}) →\n${text!.text!.slice(0, 400)}…`);
  log(`[${name}] resource links: ${links.map((l) => `${l.name} <${l.uri}>`).join(' | ')}`);

  if (links[0]?.uri) {
    const [content] = (await client.readResource({ uri: links[0].uri })).contents;
    // Resource contents are either text or a base64 blob.
    const first = content && 'text' in content ? content.text.split('\n')[0] : '(binary)';
    log(`[${name}] read ${links[0].uri} → ${first}`);
  }
  await client.close();
}

if (values.transport !== 'stdio') {
  const { mcpUrl, token } = await discoverAndGetToken(values.api!);
  await exercise('http', new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
}
if (values.transport !== 'http') {
  const stdioEntry = fileURLToPath(new URL('../mcp/stdio.js', import.meta.url));
  await exercise('stdio', new StdioClientTransport({
    command: process.execPath,
    args: [stdioEntry],
    env: { RAG_CLIENT_ID: clientId, RAG_CLIENT_SECRET: clientSecret, RAG_API_URL: values.api! },
    stderr: 'inherit',
  }));
}
