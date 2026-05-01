// Relay entry point.
// Boots the OAuth authorization server and the MCP resource server on separate ports.

import { randomUUID } from 'node:crypto';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.js';
import { openStorage } from './storage.js';
import { registerTools } from './tools.js';

const config = loadConfig();
const storage = openStorage(config.dbPath);

console.log(`[relay] storage opened at ${config.dbPath}`);

// --- MCP resource server ---
const mcpApp = express();
mcpApp.use(express.json({ limit: '10mb' }));

mcpApp.get('/healthz', (_req, res) => {
  res.json({ ok: true, role: 'mcp', publicUrl: config.mcpPublicUrl.href });
});

// Per-session transports keyed by Mcp-Session-Id.
const transports = new Map<string, StreamableHTTPServerTransport>();

function buildServer(): McpServer {
  const server = new McpServer({ name: 'relay', version: '0.1.0' });
  registerTools(server, {
    storage,
    // TODO(oauth-phase): replace with the authenticated client_id from the bearer token.
    resolveSource: () => 'unauthenticated-dev',
  });
  return server;
}

mcpApp.post('/mcp', async (req, res) => {
  const sessionId = req.header('mcp-session-id');

  if (sessionId !== undefined && transports.has(sessionId)) {
    await transports.get(sessionId)!.handleRequest(req, res, req.body);
    return;
  }

  if (sessionId === undefined && isInitializeRequest(req.body)) {
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid: string): void => {
        transports.set(sid, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId !== undefined) {
        transports.delete(transport.sessionId);
      }
    };
    const server = buildServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  res.status(400).json({
    jsonrpc: '2.0',
    error: { code: -32600, message: 'Invalid request: missing session or initialize' },
    id: null,
  });
});

// GET /mcp is used by the SDK for server-initiated streams (SSE pull).
mcpApp.get('/mcp', async (req, res) => {
  const sessionId = req.header('mcp-session-id');
  if (sessionId === undefined || !transports.has(sessionId)) {
    res.status(400).end();
    return;
  }
  await transports.get(sessionId)!.handleRequest(req, res);
});

mcpApp.delete('/mcp', async (req, res) => {
  const sessionId = req.header('mcp-session-id');
  if (sessionId === undefined || !transports.has(sessionId)) {
    res.status(400).end();
    return;
  }
  await transports.get(sessionId)!.handleRequest(req, res);
});

mcpApp.listen(config.mcpPort, () => {
  console.log(`[relay] MCP resource server listening on :${config.mcpPort}`);
  console.log(`[relay] public URL: ${config.mcpPublicUrl.href}`);
});

// --- OAuth authorization server (still stubbed) ---
const authApp = express();

authApp.get('/healthz', (_req, res) => {
  res.json({ ok: true, role: 'auth', publicUrl: config.authPublicUrl.href });
});

// TODO(oauth-phase): mount /.well-known/oauth-authorization-server
// TODO(oauth-phase): mount /register (Dynamic Client Registration, RFC 7591)
// TODO(oauth-phase): mount /authorize (PKCE)
// TODO(oauth-phase): mount /token

authApp.listen(config.authPort, () => {
  console.log(`[relay] OAuth auth server listening on :${config.authPort}`);
  console.log(`[relay] public URL: ${config.authPublicUrl.href}`);
});

// Graceful shutdown
function shutdown() {
  console.log('[relay] shutting down');
  storage.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
