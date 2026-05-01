// Strict environment configuration for Relay.
// Fails fast on startup if any required value is missing — no defaults, no fallbacks.

export interface Config {
  readonly mcpPort: number;
  readonly mcpPublicUrl: URL;
  readonly authPort: number;
  readonly authPublicUrl: URL;
  readonly oauthSigningKey: string;
  /** Passcode the user must enter on the consent screen to approve a Connector. */
  readonly adminPasscode: string;
  readonly dbPath: string;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
}

class ConfigError extends Error {
  constructor(message: string) {
    super(`[relay/config] ${message}`);
    this.name = 'ConfigError';
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new ConfigError(`required env var ${name} is not set`);
  }
  return value;
}

function requirePort(name: string): number {
  const raw = requireEnv(name);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`env var ${name} must be a valid port number, got "${raw}"`);
  }
  return port;
}

function requireUrl(name: string): URL {
  const raw = requireEnv(name);
  try {
    return new URL(raw);
  } catch {
    throw new ConfigError(`env var ${name} must be a valid URL, got "${raw}"`);
  }
}

function requireLogLevel(name: string): Config['logLevel'] {
  const raw = requireEnv(name);
  if (raw !== 'debug' && raw !== 'info' && raw !== 'warn' && raw !== 'error') {
    throw new ConfigError(`env var ${name} must be one of debug|info|warn|error, got "${raw}"`);
  }
  return raw;
}

export function loadConfig(): Config {
  const oauthSigningKey = requireEnv('RELAY_OAUTH_SIGNING_KEY');
  if (oauthSigningKey.length < 32) {
    throw new ConfigError('RELAY_OAUTH_SIGNING_KEY must be at least 32 characters');
  }

  const adminPasscode = requireEnv('RELAY_ADMIN_PASSCODE');
  if (adminPasscode.length < 8) {
    throw new ConfigError('RELAY_ADMIN_PASSCODE must be at least 8 characters');
  }

  return {
    mcpPort: requirePort('RELAY_PORT'),
    mcpPublicUrl: requireUrl('RELAY_PUBLIC_URL'),
    authPort: requirePort('RELAY_AUTH_PORT'),
    authPublicUrl: requireUrl('RELAY_AUTH_PUBLIC_URL'),
    oauthSigningKey,
    adminPasscode,
    dbPath: requireEnv('RELAY_DB_PATH'),
    logLevel: requireLogLevel('LOG_LEVEL'),
  };
}
