#!/bin/sh
# The container's answer to "where does .env come from".
#
# lib/config.js reads the file and nothing else (deliberately, so that what a
# machine says about itself is written down in one place) and a container's
# machine-describing settings arrive as environment variables. So they are
# written into the file, on every boot, before the server starts.
#
# The file lives on the state volume rather than in the image: `npm run
# set-password` writes the login into it, and that must survive the container
# being replaced. Keys this script does not manage, those two and anything
# hand-added, are carried across the rewrite untouched.
set -e

STATE_ENV=/app/state/.env
APP_ENV=/app/.env

# Everything lib/config.js reads, whether required or optional. A key absent
# from the environment is left out of the file entirely, so the optional ones
# keep the defaults config.js gives them.
MANAGED='PORT BIND_HOST PUBLIC_BASE_URL GITHUB_TOKEN WORKSPACE_DIR TEST_VIDEOS_DIR
CLAUDE_MODEL CLAUDE_EFFORT CLAUDE_BIN CODEX_BIN GROK_BIN OPENCODE_BIN
DB_HOST DB_PORT DB_DATABASE DB_USERNAME DB_PASSWORD
AUTH_USERNAME AUTH_SESSION_DAYS
DB_POOL_ENABLED DB_POOL_WAIT_TIMEOUT_MIN DB_POOL_POLL_SECONDS
DEV_MAX_SESSIONS DEV_TIMEOUT_MIN'
# R2_* is deliberately NOT written to the file: every shell command a session
# runs can read this .env, and the bucket's write credential must not be in
# it. lib/config.js reads those five straight from the process environment,
# which job children never see (jobEnv strips R2_*).

# A .env mounted over /app/.env is the operator's own file: it is the whole
# configuration, and nothing here touches it.
if [ -f "$APP_ENV" ] && [ ! -L "$APP_ENV" ]; then
    echo "entrypoint: using the .env mounted at $APP_ENV"
else
    mkdir -p /app/state
    tmp="$STATE_ENV.tmp"
    {
        echo '# Written by the container entrypoint from the environment, every boot.'
        echo '# Edits to these keys belong in compose.yaml; anything else added here is kept.'
        for key in $MANAGED; do
            # Set-but-empty is a real answer for DB_PASSWORD, so presence is the
            # test, not truthiness.
            if printenv "$key" >/dev/null 2>&1; then
                printf '%s=%s\n' "$key" "$(printenv "$key")"
            fi
        done
        if [ -f "$STATE_ENV" ]; then
            echo
            echo '# Kept from the previous boot, written by set-password or by hand.'
            awk -v managed="$(echo $MANAGED)" '
                BEGIN { split(managed, a, " "); for (i in a) skip[a[i]] = 1 }
                /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
                { eq = index($0, "="); if (eq == 0) next
                  key = substr($0, 1, eq - 1); gsub(/[[:space:]]/, "", key)
                  if (!(key in skip)) print }
            ' "$STATE_ENV"
        fi
    } > "$tmp"
    mv "$tmp" "$STATE_ENV"
    ln -sfn "$STATE_ENV" "$APP_ENV"
fi

# Pushes and fetches authenticate the way the README describes: through a
# credential helper, never through credentials the app injects. In here that
# helper is gh, which reads the same token the sessions get.
if [ -n "${GITHUB_TOKEN:-}" ]; then
    export GH_TOKEN="$GITHUB_TOKEN"
    git config --global --replace-all credential."https://github.com".helper '!gh auth git-credential'
fi

# A commit an agent makes needs an author, and a fresh container has none.
if [ -n "${GIT_USER_NAME:-}" ]; then
    git config --global user.name "$GIT_USER_NAME"
fi
if [ -n "${GIT_USER_EMAIL:-}" ]; then
    git config --global user.email "$GIT_USER_EMAIL"
fi

# The session clones are owned by this user but arrive through a volume, and
# git refuses to work in a tree whose owner it does not recognise.
git config --global --replace-all safe.directory '*'

exec "$@"
