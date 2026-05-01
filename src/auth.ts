// OAuth 2.1 authorization server + bearer auth provider for Relay.
// Implements the OAuthServerProvider interface that the MCP SDK expects.

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Request, Response } from 'express';
import express from 'express';
import Database from 'better-sqlite3';
import { SignJWT, jwtVerify } from 'jose';
import type { Storage } from './storage.js';
import type {
  OAuthRegisteredClientsStore,
} from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

const ACCESS_TOKEN_TTL_SEC = 60 * 60 * 24; // 24 hours
const PENDING_TTL_MS = 10 * 60 * 1000;     // 10 minutes
const CODE_TTL_MS = 60 * 1000;             // 1 minute

const AUTH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id      TEXT PRIMARY KEY,
  client_name    TEXT NOT NULL,
  redirect_uris  TEXT NOT NULL,
  scopes         TEXT,
  registered_at  INTEGER NOT NULL,
  data           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code                  TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL,
  redirect_uri          TEXT NOT NULL,
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  scope                 TEXT,
  expires_at            INTEGER NOT NULL,
  consumed              INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS oauth_pending (
  session_id            TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL,
  redirect_uri          TEXT NOT NULL,
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  state                 TEXT,
  scope                 TEXT,
  expires_at            INTEGER NOT NULL
);
`;

interface PendingRow {
  session_id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  state: string | null;
  scope: string | null;
  expires_at: number;
}

interface CodeRow {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string | null;
  expires_at: number;
  consumed: number;
}

interface ClientRow {
  client_id: string;
  client_name: string;
  redirect_uris: string;
  scopes: string | null;
  registered_at: number;
  data: string;
}

interface ProviderDeps {
  readonly db: Database.Database;
  readonly signingKey: Uint8Array;
  readonly issuer: URL;
  readonly audience: URL;
  readonly consentUrl: URL;
  readonly relayStorage: Storage;
}

class RelayClientsStore implements OAuthRegisteredClientsStore {
  private readonly getStmt: Database.Statement<[string], ClientRow>;
  private readonly insertStmt: Database.Statement<[string, string, string, string | null, number, string]>;

  constructor(db: Database.Database) {
    this.getStmt = db.prepare<[string], ClientRow>(
      `SELECT client_id, client_name, redirect_uris, scopes, registered_at, data
         FROM oauth_clients WHERE client_id = ?`,
    );
    this.insertStmt = db.prepare<[string, string, string, string | null, number, string]>(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, scopes, registered_at, data)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.getStmt.get(clientId);
    if (row === undefined) return undefined;
    return JSON.parse(row.data) as OAuthClientInformationFull;
  }

  registerClient(
    input: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
  ): OAuthClientInformationFull {
    const clientId = `client_${randomBytes(12).toString('hex')}`;
    const now = Math.floor(Date.now() / 1000);
    const full: OAuthClientInformationFull = {
      ...input,
      client_id: clientId,
      client_id_issued_at: now,
    };
    const clientName = full.client_name ?? 'Unnamed Connector';
    this.insertStmt.run(
      clientId,
      clientName,
      JSON.stringify(full.redirect_uris),
      full.scope ?? null,
      now * 1000,
      JSON.stringify(full),
    );
    return full;
  }
}

function makePendingHelpers(db: Database.Database) {
  const insert = db.prepare<[string, string, string, string, string, string | null, string | null, number]>(
    `INSERT INTO oauth_pending
       (session_id, client_id, redirect_uri, code_challenge, code_challenge_method, state, scope, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const get = db.prepare<[string], PendingRow>(
    `SELECT session_id, client_id, redirect_uri, code_challenge, code_challenge_method, state, scope, expires_at
       FROM oauth_pending WHERE session_id = ?`,
  );
  const del = db.prepare<[string]>(`DELETE FROM oauth_pending WHERE session_id = ?`);
  return { insert, get, del };
}

function makeCodeHelpers(db: Database.Database) {
  const insert = db.prepare<[string, string, string, string, string, string | null, number]>(
    `INSERT INTO oauth_codes
       (code, client_id, redirect_uri, code_challenge, code_challenge_method, scope, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const get = db.prepare<[string], CodeRow>(
    `SELECT code, client_id, redirect_uri, code_challenge, code_challenge_method, scope, expires_at, consumed
       FROM oauth_codes WHERE code = ?`,
  );
  const consume = db.prepare<[string]>(`UPDATE oauth_codes SET consumed = 1 WHERE code = ?`);
  return { insert, get, consume };
}

class RelayProvider implements OAuthServerProvider {
  readonly clientsStore: RelayClientsStore;
  private readonly pending: ReturnType<typeof makePendingHelpers>;
  private readonly codes: ReturnType<typeof makeCodeHelpers>;

  constructor(private readonly deps: ProviderDeps) {
    this.clientsStore = new RelayClientsStore(deps.db);
    this.pending = makePendingHelpers(deps.db);
    this.codes = makeCodeHelpers(deps.db);
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const sessionId = randomUUID();
    this.pending.insert.run(
      sessionId,
      client.client_id,
      params.redirectUri,
      params.codeChallenge,
      'S256',
      params.state ?? null,
      params.scopes !== undefined && params.scopes.length > 0 ? params.scopes.join(' ') : null,
      Date.now() + PENDING_TTL_MS,
    );
    const consent = new URL(this.deps.consentUrl.href);
    consent.searchParams.set('session', sessionId);
    res.redirect(consent.href);
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const row = this.codes.get.get(authorizationCode);
    if (row === undefined) throw new Error('invalid authorization code');
    return row.code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    _resource?: URL,
  ): Promise<OAuthTokens> {
    const row = this.codes.get.get(authorizationCode);
    if (row === undefined) throw new Error('invalid authorization code');
    if (row.consumed === 1) throw new Error('authorization code already used');
    if (row.expires_at < Date.now()) throw new Error('authorization code expired');
    if (row.client_id !== client.client_id) throw new Error('client_id mismatch');
    if (redirectUri !== undefined && redirectUri !== row.redirect_uri) {
      throw new Error('redirect_uri mismatch');
    }
    this.codes.consume.run(authorizationCode);

    const accessToken = await this.mintAccessToken(client.client_id, row.scope ?? undefined);
    const tokens: OAuthTokens = {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SEC,
    };
    if (row.scope !== null) tokens.scope = row.scope;
    return tokens;
  }

  async exchangeRefreshToken(): Promise<OAuthTokens> {
    throw new Error('refresh tokens not supported');
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const { payload } = await jwtVerify(token, this.deps.signingKey, {
      issuer: this.deps.issuer.href,
      audience: this.deps.audience.href,
    });
    if (typeof payload.sub !== 'string') throw new Error('token missing sub');
    const scope = typeof payload.scope === 'string' ? payload.scope : '';
    const info: AuthInfo = {
      token,
      clientId: payload.sub,
      scopes: scope.length > 0 ? scope.split(' ') : [],
    };
    if (typeof payload.exp === 'number') info.expiresAt = payload.exp;
    return info;
  }

  async approveConsent(sessionId: string): Promise<{ redirectTo: string }> {
    const row = this.pending.get.get(sessionId);
    if (row === undefined) throw new Error('consent session not found or expired');
    if (row.expires_at < Date.now()) {
      this.pending.del.run(sessionId);
      throw new Error('consent session expired');
    }
    const code = randomBytes(24).toString('base64url');
    this.codes.insert.run(
      code,
      row.client_id,
      row.redirect_uri,
      row.code_challenge,
      row.code_challenge_method,
      row.scope,
      Date.now() + CODE_TTL_MS,
    );
    this.pending.del.run(sessionId);

    const redirect = new URL(row.redirect_uri);
    redirect.searchParams.set('code', code);
    if (row.state !== null) redirect.searchParams.set('state', row.state);
    return { redirectTo: redirect.href };
  }

  getPending(sessionId: string): { clientName: string; redirectUri: string } | null {
    const row = this.pending.get.get(sessionId);
    if (row === undefined) return null;
    if (row.expires_at < Date.now()) return null;
    const client = this.clientsStore.getClient(row.client_id);
    return {
      clientName: client?.client_name ?? row.client_id,
      redirectUri: row.redirect_uri,
    };
  }

  rememberSource(clientId: string): void {
    const client = this.clientsStore.getClient(clientId);
    if (client === undefined) return;
    this.deps.relayStorage.registerClient({
      clientId,
      sourceLabel: client.client_name ?? clientId,
    });
    this.deps.relayStorage.touchClient(clientId);
  }

  private async mintAccessToken(clientId: string, scope?: string): Promise<string> {
    const jwt = new SignJWT(scope === undefined ? {} : { scope })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(this.deps.issuer.href)
      .setAudience(this.deps.audience.href)
      .setSubject(clientId)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TOKEN_TTL_SEC}s`);
    return jwt.sign(this.deps.signingKey);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default:  return c;
    }
  });
}

function renderConsentPage(opts: { clientName: string; redirectUri: string; sessionId: string; formAction: string; error?: string }): string {
  const errBlock = opts.error === undefined
    ? ''
    : `<p class="err">${escapeHtml(opts.error)}</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Approve Connector — Relay</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 28rem; margin: 4rem auto; padding: 0 1rem; color: #222; }
  h1 { font-size: 1.4rem; }
  .card { border: 1px solid #ddd; border-radius: 0.5rem; padding: 1.25rem; }
  dl { margin: 0; }
  dt { font-weight: 600; margin-top: 0.5rem; color: #555; font-size: 0.85rem; }
  dd { margin: 0; word-break: break-all; }
  input[type=password] { width: 100%; padding: 0.5rem; font-size: 1rem; box-sizing: border-box; }
  button { width: 100%; padding: 0.75rem; font-size: 1rem; background: #111; color: #fff; border: 0; border-radius: 0.4rem; margin-top: 0.75rem; cursor: pointer; }
  .err { color: #b00020; margin-top: 0.5rem; }
  .hint { color: #666; font-size: 0.85rem; margin-top: 1rem; }
</style>
</head>
<body>
<h1>Approve this Connector?</h1>
<form method="POST" action="${escapeHtml(opts.formAction)}" class="card">
  <input type="hidden" name="session" value="${escapeHtml(opts.sessionId)}" />
  <dl>
    <dt>Application</dt>
    <dd>${escapeHtml(opts.clientName)}</dd>
    <dt>Will redirect to</dt>
    <dd><code>${escapeHtml(opts.redirectUri)}</code></dd>
  </dl>
  <p class="hint">Enter the admin passcode to approve.</p>
  <label for="passcode" style="display:block;margin-top:0.5rem;">Passcode</label>
  <input id="passcode" name="passcode" type="password" autocomplete="off" required />
  ${errBlock}
  <button type="submit">Approve</button>
</form>
</body>
</html>`;
}

function renderMessagePage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title)} — Relay</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#222}</style>
</head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></body></html>`;
}

function openAuthDb(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(AUTH_SCHEMA_SQL);
  return db;
}

export interface AuthSubsystem {
  readonly provider: RelayProvider;
  /** Mount /consent (GET, POST) at the given absolute path (e.g. "/relay/auth/consent"). */
  mountConsent(app: express.Express, consentPath: string, adminPasscode: string): void;
  close(): void;
}

export function openAuthSubsystem(opts: {
  dbPath: string;
  signingKey: string;
  issuer: URL;
  audience: URL;
  consentUrl: URL;
  relayStorage: Storage;
}): AuthSubsystem {
  const db = openAuthDb(opts.dbPath);
  const provider = new RelayProvider({
    db,
    signingKey: new TextEncoder().encode(opts.signingKey),
    issuer: opts.issuer,
    audience: opts.audience,
    consentUrl: opts.consentUrl,
    relayStorage: opts.relayStorage,
  });

  return {
    provider,
    mountConsent(app, consentPath, adminPasscode) {
      app.use(express.urlencoded({ extended: false }));

      app.get(consentPath, (req: Request, res: Response) => {
        const sessionId = req.query.session;
        if (typeof sessionId !== 'string') {
          res.status(400).type('html').send(renderMessagePage('Missing session', 'No consent session was provided.'));
          return;
        }
        const pending = provider.getPending(sessionId);
        if (pending === null) {
          res.status(404).type('html').send(renderMessagePage('Expired', 'This consent session is invalid or expired. Restart the connector setup from the client app.'));
          return;
        }
        res.type('html').send(renderConsentPage({ ...pending, sessionId, formAction: consentPath }));
      });

      app.post(consentPath, async (req: Request, res: Response) => {
        const session = (req.body as { session?: unknown })?.session;
        const passcode = (req.body as { passcode?: unknown })?.passcode;
        if (typeof session !== 'string' || typeof passcode !== 'string') {
          res.status(400).type('html').send(renderMessagePage('Bad request', 'Missing fields.'));
          return;
        }
        const pending = provider.getPending(session);
        if (pending === null) {
          res.status(404).type('html').send(renderMessagePage('Expired', 'This consent session is invalid or expired.'));
          return;
        }
        if (passcode !== adminPasscode) {
          res.status(401).type('html').send(renderConsentPage({ ...pending, sessionId: session, formAction: consentPath, error: 'Wrong passcode.' }));
          return;
        }
        const { redirectTo } = await provider.approveConsent(session);
        res.redirect(redirectTo);
      });
    },
    close() {
      db.close();
    },
  };
}
