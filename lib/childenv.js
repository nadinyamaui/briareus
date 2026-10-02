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
//   CREDENTIALS_KEY     decrypts the database logins stored per SSH server
//   FORGE_*             the Laravel Forge token, which manages every server in
//                       its organization
const SERVER_ONLY = [
  'R2_',
  'CLOUDFLARE_',
  'OPENAI_TRANSCRIBE_',
  'PREVIEW_ACCESS_CLIENT_',
  'CREDENTIALS_KEY',
  'FORGE_',
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
