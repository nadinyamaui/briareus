# The core itself, in a container: node, the provider CLIs, and the
# command-line tools a session shells out to (git, gh, the mysql and psql
# clients). What it deliberately does not carry is any given project's
# toolchain: a project's setup steps are operator-authored and run whatever is
# on PATH, so an install that reviews PHP repositories adds php/composer here.
FROM node:24-bookworm-slim

# gh comes from GitHub's own apt repository rather than a pinned tarball: the
# CLI talks to an API that moves, and a version frozen at build time is the one
# that starts refusing calls months later.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg git openssh-client less procps tini \
        default-mysql-client postgresql-client; \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg; \
    chmod a+r /usr/share/keyrings/githubcli-archive-keyring.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends gh; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The lockfile alone first, so a source edit does not re-run the install.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit && npm cache clean --force

# The Claude Code, codex and opencode CLIs are dependencies of this app, so the
# image already has them. Put them where the binary discovery in lib/config.js
# and lib/providers.js looks (PATH, then /usr/local/bin) instead of installing
# second copies.
RUN ln -sf /app/node_modules/.bin/claude /usr/local/bin/claude \
    && ln -sf /app/node_modules/.bin/codex /usr/local/bin/codex \
    && ln -sf /app/node_modules/.bin/opencode /usr/local/bin/opencode

# grok is not on npm (the `grok-cli` package there is an unrelated wrapper), so
# it comes from x.ai's installer. Its download dir is fixed at $HOME/.grok, and
# /home/node is a volume at runtime, so the install runs with a HOME of its own
# under /opt and links the binary onto PATH from there.
RUN set -eux; \
    HOME=/opt/grok GROK_BIN_DIR=/usr/local/bin bash -c "$(curl -fsSL https://x.ai/cli/install.sh)"; \
    chmod -R a+rX /opt/grok; \
    grok --version

COPY . .
COPY docker/entrypoint.sh /usr/local/bin/reviewer-entrypoint
RUN chmod +x /usr/local/bin/reviewer-entrypoint

# Everything the container writes lives in one of these, and each one is a
# volume in compose.yaml: the .env (and the signing secret `npm run
# create-token` writes into it), the provider CLIs' logins under HOME, the
# session clones and the test-run videos.
RUN mkdir -p /app/state /workspaces /test-videos \
    && chown -R node:node /app /workspaces /test-videos

ENV NODE_ENV=production \
    HOME=/home/node \
    WORKSPACE_DIR=/workspaces \
    TEST_VIDEOS_DIR=/test-videos

USER node

# tini as pid 1: a session's turns are spawned detached, as process-group
# leaders, and node is not going to reap the ones that outlive their turn.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/reviewer-entrypoint"]
CMD ["node", "server.js"]
