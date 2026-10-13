/**
 * Best-effort secret redaction for anything the factory prints or persists
 * (command output, error messages). It is a safety net, not a guarantee.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g, // Anthropic API keys
  /sk-[A-Za-z0-9]{20,}/g, // generic "sk-" style keys
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /AKIA[0-9A-Z]{16}/g, // AWS access key ids
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(password|passwd|secret|token|api[_-]?key)\s*[=:]\s*\S+/gi,
];

export const REDACTED = '[REDACTED]';

export function redactSecrets(text: string, extraSecrets: readonly string[] = []): string {
  let out = text;
  for (const secret of extraSecrets) {
    if (secret.length >= 6) out = out.split(secret).join(REDACTED);
  }
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/**
 * High-confidence secret formats, used to flag added diff lines. Deliberately
 * narrower than redaction so ordinary code (e.g. `token: string`) is not flagged.
 */
const SECRET_DETECTORS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'Anthropic API key', pattern: /sk-ant-[A-Za-z0-9_-]{10,}/ },
  { name: 'sk- style API key', pattern: /\bsk-[A-Za-z0-9]{20,}/ },
  { name: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'private key block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    name: 'hard-coded credential',
    pattern: /\b(password|passwd|secret|api[_-]?key|access[_-]?token)\b\s*[=:]\s*["'][^"'\s]{8,}["']/i,
  },
];

/** Names of secret formats found in `text` (empty if none). */
export function findSecretLikeContent(text: string): string[] {
  return SECRET_DETECTORS.filter((d) => d.pattern.test(text)).map((d) => d.name);
}

/**
 * Environment variables passed to child processes. Everything else (API keys,
 * tokens, cloud credentials) is withheld by default.
 */
const SAFE_ENV_KEYS: readonly string[] = [
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'LANG',
  'TERM',
];

export function buildSafeEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const allowed = new Set(SAFE_ENV_KEYS.map((k) => k.toUpperCase()));
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && allowed.has(key.toUpperCase())) env[key] = value;
  }
  return env;
}
