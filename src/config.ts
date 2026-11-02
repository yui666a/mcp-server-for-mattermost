export type Config = {
  publicUrl: string;
  resource: string;
  issuer: string;
  mmUrl: string;
  mmBrowserUrl: string;
  mmClientId: string;
  mmClientSecret: string;
  encKey: Buffer;
  dbPath: string;
  port: number;
  accessTokenTtlSec: number;
  extraRedirectUris: string[];
  extraOrigins: string[];
  uploadMaxBytes: number;
};

const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  if (env[name] === undefined) return fallback;
  const n = Number(env[name]);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const publicUrl = required(env, 'PUBLIC_URL');
  if (publicUrl.endsWith('/')) throw new Error('PUBLIC_URL must not end with a slash');
  const encKey = Buffer.from(required(env, 'TOKEN_ENC_KEY'), 'base64');
  if (encKey.length !== 32) throw new Error('TOKEN_ENC_KEY must be 32 bytes in base64');
  const mmUrl = env.MM_URL || publicUrl;
  return {
    publicUrl,
    resource: `${publicUrl}/mcp`,
    issuer: `${publicUrl}/mcp`,
    mmUrl,
    mmBrowserUrl: env.MM_BROWSER_URL || mmUrl,
    mmClientId: required(env, 'MM_OAUTH_CLIENT_ID'),
    mmClientSecret: required(env, 'MM_OAUTH_CLIENT_SECRET'),
    encKey,
    dbPath: env.DB_PATH || '/data/mcp.sqlite',
    port: positiveInt(env, 'PORT', 3000),
    accessTokenTtlSec: positiveInt(env, 'ACCESS_TOKEN_TTL_SEC', 3600),
    extraRedirectUris: list(env.EXTRA_REDIRECT_URIS),
    extraOrigins: list(env.EXTRA_ALLOWED_ORIGINS),
    uploadMaxBytes: positiveInt(env, 'UPLOAD_MAX_BYTES', 20 * 1024 * 1024),
  };
}
