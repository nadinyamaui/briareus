# Security

## What this app is

Briareus runs coding agents on the machine it is installed on. A
session spawns a CLI that edits files, runs shell commands, and pushes to
GitHub with the credentials that machine already has. **Anything that can reach
the port can do all of that.** That is the feature, not a flaw, but it means
the deployment decisions below are part of the security model, not
hardening you get to postpone.

## The two gates

The server listens on `127.0.0.1` only, so a default install is reachable from
that machine and nowhere else. Both gates below matter the moment you put a
hostname in front of it:

1. **At the edge.** Put an authenticating proxy on the hostname: a Cloudflare
   Access application with a policy that allows only your own account is what
   this is set up for. `/webhooks` needs a Bypass policy of its own, since
   GitHub cannot sign into your account; those deliveries authenticate
   themselves with an HMAC signature.
2. **In the app.** `npm run set-password` writes `AUTH_USERNAME`,
   `AUTH_PASSWORD_HASH` (scrypt) and `AUTH_SECRET` into `.env`. Until both keys
   are set the boot log says `login: OFF` and every request is trusted.

**`login: OFF` plus a public hostname is a remote shell for anyone who finds
it.** The boot log says so on every start; please believe it.

## Credentials this app holds

- `GITHUB_TOKEN`: a classic PAT with `repo`, or fine-grained with Pull
  requests read/write and Contents read. It can push to and comment on every
  repository in its scope. Scope it to the repositories you actually run
  sessions against.
- The provider CLI logins (Claude, Codex, Grok), which live in the CLIs' own
  config directories rather than here.
- The database pool credentials, stored in the app's own database and edited at
  `/settings`.
- Git pushes use the machine's own credential helper. The app injects no git
  credentials of its own.

Sessions run with the permissions of the user running the server. There is no
sandbox between a session and the rest of that machine: a project's setup
commands and run commands are shell, by design.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private vulnerability reporting on this repository:
[Security → Report a vulnerability](https://github.com/nadinyamaui/briareus/security/advisories/new).
That opens a private advisory only the maintainers can see.

Include what you need to reproduce it: the route or setting involved, what you
expected, and what happened instead. If it depends on a particular
configuration (login off, a public hostname, a specific token scope), say so:
that usually is the finding.

Expect an acknowledgement within a week. This is a small project maintained in
spare time, so please size your expectations to that; there is no on-call
rotation behind this file.

## Supported versions

`main` is the only supported version. There are no release branches and no
backports; fixes land on `main` and you deploy by pulling it.
