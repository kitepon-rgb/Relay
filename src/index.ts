// Relay entry point.
// Single Express app on RELAY_PORT serves both the MCP resource server and
// the OAuth authorization server, namespaced by path so it can coexist with
// other MCPs behind the same reverse-proxy hostname.

import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { metadataHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/metadata.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { loadConfig } from './config.js';
import { openStorage } from './storage.js';
import { registerTools } from './tools.js';
import { openAuthSubsystem } from './auth.js';

const config = loadConfig();
const storage = openStorage(config.dbPath);
console.log(`[relay] storage opened at ${config.dbPath}`);

// Derived paths — all routes mount at the public path so caddy can plain-proxy.
const mcpPath          = config.publicMcpUrl.pathname;
const authBasePath     = config.publicAuthUrl.pathname.replace(/\/$/, '');
const authorizePath    = `${authBasePath}/authorize`;
const tokenPath        = `${authBasePath}/token`;
const registerPath     = `${authBasePath}/register`;
const consentPath      = `${authBasePath}/consent`;
const asMetadataPath   = `/.well-known/oauth-authorization-server${authBasePath}`;
const rsMetadataPath   = `/.well-known/oauth-protected-resource${mcpPath}`;

const consentUrl = new URL(consentPath, config.publicAuthUrl);

const auth = openAuthSubsystem({
  dbPath: config.dbPath,
  signingKey: config.oauthSigningKey,
  issuer: config.publicAuthUrl,
  audience: config.publicMcpUrl,
  consentUrl,
  relayStorage: storage,
});

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));

// --- Health ---
app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    mcp: config.publicMcpUrl.href,
    auth: config.publicAuthUrl.href,
  });
});

// --- OAuth metadata (RFC 8414 + RFC 9728) ---
const asMetadata = {
  issuer: config.publicAuthUrl.href.replace(/\/$/, ''),
  authorization_endpoint: new URL(authorizePath, config.publicAuthUrl).href.replace(/\/$/, ''),
  token_endpoint: new URL(tokenPath, config.publicAuthUrl).href.replace(/\/$/, ''),
  registration_endpoint: new URL(registerPath, config.publicAuthUrl).href.replace(/\/$/, ''),
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
};

const rsMetadata = {
  resource: config.publicMcpUrl.href,
  authorization_servers: [config.publicAuthUrl.href.replace(/\/$/, '')],
  resource_name: 'Relay',
};

app.use(asMetadataPath, metadataHandler(asMetadata));
app.use(rsMetadataPath, metadataHandler(rsMetadata));

// --- OAuth endpoints ---
app.use(registerPath, clientRegistrationHandler({ clientsStore: auth.provider.clientsStore }));
app.use(authorizePath, authorizationHandler({ provider: auth.provider }));
app.use(tokenPath, tokenHandler({ provider: auth.provider }));
auth.mountConsent(app, consentPath, config.adminPasscode);

// --- MCP endpoint (Bearer protected) ---
const bearer = requireBearerAuth({
  verifier: { verifyAccessToken: token => auth.provider.verifyAccessToken(token) },
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.publicMcpUrl),
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

app.post(mcpPath, bearer, async (req: Request, res: Response) => {
  const sessionId = req.header('mcp-session-id');

  if (sessionId !== undefined && transports.has(sessionId)) {
    await transports.get(sessionId)!.handleRequest(req, res, req.body);
    return;
  }

  // Stale session id (e.g. server restart cleared the in-memory transports map).
  // MCP Streamable HTTP spec requires 404 here so the client SDK discards the
  // session and reinitializes on the next request instead of looping on errors.
  if (sessionId !== undefined) {
    res.status(404).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Session not found' },
      id: null,
    });
    return;
  }

  if (isInitializeRequest(req.body)) {
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

app.get(mcpPath, bearer, async (req: Request, res: Response) => {
  const sessionId = req.header('mcp-session-id');
  if (sessionId === undefined) {
    res.status(400).end();
    return;
  }
  if (!transports.has(sessionId)) {
    res.status(404).end();
    return;
  }
  await transports.get(sessionId)!.handleRequest(req, res);
});

app.delete(mcpPath, bearer, async (req: Request, res: Response) => {
  const sessionId = req.header('mcp-session-id');
  if (sessionId === undefined) {
    res.status(400).end();
    return;
  }
  if (!transports.has(sessionId)) {
    res.status(404).end();
    return;
  }
  await transports.get(sessionId)!.handleRequest(req, res);
});

app.listen(config.port, () => {
  console.log(`[relay] listening on :${config.port}`);
  console.log(`[relay] public MCP:  ${config.publicMcpUrl.href}`);
  console.log(`[relay] public AUTH: ${config.publicAuthUrl.href}`);
  console.log(`[relay] AS metadata: ${asMetadataPath}`);
  console.log(`[relay] RS metadata: ${rsMetadataPath}`);
});

function shutdown(): void {
  console.log('[relay] shutting down');
  storage.close();
  auth.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
