#!/usr/bin/env bash
# Installs a private WAHA beside a bare-metal Briareus core. Re-running keeps
# both the API key and the volumes; it does not start/link a WhatsApp account.
set -euo pipefail
umask 077
install_dir="${WAHA_INSTALL_DIR:-$HOME/.config/briareus/waha}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command -v docker >/dev/null
docker compose version >/dev/null
mkdir -p "$install_dir"
chmod 700 "$install_dir"
if [[ ! -f "$install_dir/.env" ]]; then
  port="${WAHA_PORT:-8203}"
  [[ "$port" =~ ^[0-9]+$ ]] && (( port > 1024 && port < 65536 )) || { echo 'WAHA_PORT must be between 1025 and 65535' >&2; exit 1; }
  image="${WAHA_IMAGE:-}"
  if [[ -z "$image" ]]; then
    case "$(uname -m)" in
      aarch64|arm64) image=devlikeapro/waha:arm ;;
      x86_64) image=devlikeapro/waha:latest ;;
      *) echo 'Set WAHA_IMAGE for this architecture' >&2; exit 1 ;;
    esac
  fi
  # Pull before writing any configuration, and pin the resolved image so a
  # re-run cannot silently upgrade a working WhatsApp engine.
  docker pull "$image"
  pinned="$(docker image inspect "$image" --format '{{index .RepoDigests 0}}')"
  [[ "$pinned" == *@sha256:* ]] || { echo 'Could not resolve WAHA image digest' >&2; exit 1; }
  api_key="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
  printf 'WAHA_IMAGE=%s\nWAHA_PORT=%s\nWAHA_URL=http://127.0.0.1:%s\nWAHA_API_KEY=%s\n' "$pinned" "$port" "$port" "$api_key" > "$install_dir/.env"
fi
chmod 600 "$install_dir/.env"
cp "$repo_root/deploy/waha/compose.yaml" "$install_dir/compose.yaml"
env -u WAHA_IMAGE -u WAHA_PORT -u WAHA_API_KEY docker compose --env-file "$install_dir/.env" --project-directory "$install_dir" -f "$install_dir/compose.yaml" up -d
node --input-type=module - "$install_dir/.env" <<'JS'
import fs from 'node:fs';
const text = fs.readFileSync(process.argv[2], 'utf8');
const read = (key) => text.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1];
let ready = false;
for (let i = 0; i < 30; i++) {
  try {
    const res = await fetch(`${read('WAHA_URL')}/api/sessions?all=true`, {
      headers: { 'X-Api-Key': read('WAHA_API_KEY') }, signal: AbortSignal.timeout(2000),
    });
    if (res.ok && Array.isArray(await res.json())) { ready = true; break; }
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!ready) { console.error('WAHA is not ready; inspect docker compose logs in the install directory'); process.exit(1); }
console.log(`WAHA is ready at ${read('WAHA_URL')}`);
JS
printf 'Set WAHA_CONFIG_FILE=%s/.env in the core environment and restart it.\n' "$install_dir"
