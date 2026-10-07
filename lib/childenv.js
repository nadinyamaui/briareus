// @ts-check
// The environment every spawned child starts from: the server's own, less credentials
// that are the server's alone. In a container these arrive as process env rather than in
// the agent-readable .env (lib/config.js), so a spawned CLI, agent shell or project run
// command would otherwise see them. Stripped: R2_* (session video upload credential),
// CLOUDFLARE_* (publishes previews; can rewrite DNS, Access and the tunnel),
// OPENAI_TRANSCRIBE_* (bills an OpenAI account), PREVIEW_ACCESS_CLIENT_* (opens every
// preview hostname), CREDENTIALS_KEY (decrypts stored SSH database logins and Envoyer and
// Forge tokens) and FORGE_* (a legacy Forge token nothing reads, still able to manage
// every server).
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
