// Relay entry point.
// Boots the OAuth authorization server and the MCP resource server on separate ports.

import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  mcpAuthRouter,
  mcpAuthMetadataRouter,
  getOAuthProtectedResourceMetadataUrl,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { loadConfig } from './config.js';
import { openStorage } from './storage.js';
import { registerTools } from './tools.js';
import { openAuthSubsystem } from './auth.js';

const config = loadConfig();
const storage = openStorage(config.dbPath);
console.log(`[relay] storage opened at ${config.dbPath}`);

const auth = openAuthSubsystem({
  dbPath: config.dbPath,
  signingKey: config.oauthSigningKey,
  issuer: config.authPublicUrl,
  audience: config.mcpPublicUrl,
  consentUrl: new URL('/consent', config.authPublicUrl),
  relayStorage: storage,
});

// --- OAuth authorization server ---
const authApp = express();

authApp.get('/healthz', (_req, res) => {
  res.json({ ok: true, role: 'auth', publicUrl: config.authPublicUrl.href });
});

authApp.use(
  mcpAuthRouter({
    provider: auth.provider,
    issuerUrl: config.authPublicUrl,
    resourceServerUrl: config.mcpPublicUrl,
    resourceName: 'Relay',
  }),
);

auth.mountConsent(authApp, config.adminPasscode);

authApp.listen(config.authPort, () => {
  console.log(`[relay] OAuth auth server listening on :${config.authPort}`);
  console.log(`[relay] public URL: ${config.authPublicUrl.href}`);
});

// --- MCP resource server ---
const mcpApp = express();
mcpApp.use(express.json({ limit: '10mb' }));

mcpApp.get('/healthz', (_req, res) => {
  res.json({ ok: true, role: 'mcp', publicUrl: config.mcpPublicUrl.href });
});

// Serve /.well-known/oauth-protected-resource/mcp so clients can discover the AS.
mcpApp.use(
  mcpAuthMetadataRouter({
    resourceServerUrl: config.mcpPublicUrl,
    oauthMetadata: {
      issuer: config.authPublicUrl.href,
      authorization_endpoint: new URL('/authorize', config.authPublicUrl).href,
      token_endpoint: new URL('/token', config.authPublicUrl).href,
      registration_endpoint: new URL('/register', config.authPublicUrl).href,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    },
    resourceName: 'Relay',
  }),
);

const bearer = requireBearerAuth({
  verifier: { verifyAccessToken: token => auth.provider.verifyAccessToken(token) },
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.mcpPublicUrl),
});

const transports = new Map<string, StreamableHTTPServerTransport>();

function buildServer(clientId: string): McpServer {
  const server = new McpServer({ name: 'relay', version: '0.1.0' });
  registerTools(server, {
    storage,
    resolveSource: () => clientId,
  });
  return server;
}

mcpApp.post('/mcp', bearer, async (req: Request, res: Response) => {
  const sessionId = req.header('mcp-session-id');

  if (sessionId !== undefined && transports.has(sessionId)) {
    await transports.get(sessionId)!.handleRequest(req, res, req.body);
    return;
  }

  if (sessionId === undefined && isInitializeRequest(req.body)) {
    const clientId = req.auth?.clientId;
    if (clientId === undefined) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    auth.provider.rememberSource(clientId);

    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid: string): void => {
        transports.set(sid, transport);
      },
    });
    transport.onclose = (): void => {
      if (transport.sessionId !== undefined) {
        transports.delete(transport.sessionId);
      }
    };
    const server = buildServer(clientId);
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

mcpApp.get('/mcp', bearer, async (req: Request, res: Response) => {
  const sessionId = req.header('mcp-session-id');
  if (sessionId === undefined || !transports.has(sessionId)) {
    res.status(400).end();
    return;
  }
  await transports.get(sessionId)!.handleRequest(req, res);
});

mcpApp.delete('/mcp', bearer, async (req: Request, res: Response) => {
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

function shutdown(): void {
  console.log('[relay] shutting down');
  storage.close();
  auth.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
