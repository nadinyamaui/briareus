// @ts-check
// The environment every child process this server spawns starts from: its
// own, less the credentials that are the server's alone. In a container these
// arrive as process environment rather than in the agent-readable .env
// (lib/config.js), and a spawned CLI, an agent's shell or a project's own run
// command would otherwise read them there.
//   R2_*                the write credential session videos are uploaded with;
//                       nothing but the server uploads them
//   CLOUDFLARE_*        the token that publishes previews, which can rewrite
//                       DNS, Access and the tunnel
//   OPENAI_TRANSCRIBE_* the key voice notes are transcribed with, which bills
//                       an OpenAI account
//   PREVIEW_ACCESS_CLIENT_*
//                       the Access service token, which opens every preview
//                       hostname
//   CREDENTIALS_KEY     decrypts the database logins stored per SSH server,
//                       the Envoyer and Laravel Forge tokens and the mailboxes'
//                       OAuth tokens
//   FORGE_*             a Forge token still exported from before the accounts
//                       moved to the database; nothing reads it, and it still
//                       manages every server in its organization
//   GOOGLE_OAUTH_*, MICROSOFT_OAUTH_*
//                       the OAuth clients mailboxes are connected through
//   WAHA_*              the private WhatsApp server’s API key and configuration
const SERVER_ONLY = [
  'R2_',
  'CLOUDFLARE_',
  'OPENAI_TRANSCRIBE_',
  'PREVIEW_ACCESS_CLIENT_',
  'CREDENTIALS_KEY',
  'FORGE_',
  'GOOGLE_OAUTH_',
  'MICROSOFT_OAUTH_',
  'WAHA_',
];

/**
 * @param {Record<string, string | undefined>} [overrides]
 * @returns {Record<string, string | undefined>}
 */
export function childEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  for (const key of Object.keys(env)) if (SERVER_ONLY.some((p) => key.startsWith(p))) delete env[key];
  return env;
}
