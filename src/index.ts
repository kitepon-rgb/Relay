// Relay entry point.
// Boots the OAuth authorization server and the MCP resource server on separate ports.

import express from 'express';
import { loadConfig } from './config.js';

const config = loadConfig();

// --- MCP resource server ---
const mcpApp = express();

mcpApp.get('/healthz', (_req, res) => {
  res.json({ ok: true, role: 'mcp', publicUrl: config.mcpPublicUrl.href });
});

// TODO(next-phase): mount /mcp endpoint with StreamableHTTPServerTransport
// TODO(next-phase): wrap /mcp with requireBearerAuth middleware
// TODO(next-phase): mount /.well-known/oauth-protected-resource via createProtectedResourceMetadataRouter

mcpApp.listen(config.mcpPort, () => {
  console.log(`[relay] MCP resource server listening on :${config.mcpPort}`);
  console.log(`[relay] public URL: ${config.mcpPublicUrl.href}`);
});

// --- OAuth authorization server ---
const authApp = express();

authApp.get('/healthz', (_req, res) => {
  res.json({ ok: true, role: 'auth', publicUrl: config.authPublicUrl.href });
});

// TODO(next-phase): mount /.well-known/oauth-authorization-server
// TODO(next-phase): mount /register (Dynamic Client Registration, RFC 7591)
// TODO(next-phase): mount /authorize (PKCE)
// TODO(next-phase): mount /token

authApp.listen(config.authPort, () => {
  console.log(`[relay] OAuth auth server listening on :${config.authPort}`);
  console.log(`[relay] public URL: ${config.authPublicUrl.href}`);
});
