# Deploying

By hand, on purpose: nothing polls GitHub and nothing restarts the server on
its own, so a commit landing on `main` never picks the moment the live checkout
changes under whoever is using it.

```bash
cd /path/to/briareus
git pull --ff-only
GROK_HOME="$PWD/node_modules/.grok" npm ci --omit=dev # only when package-lock.json moved
sudo systemctl restart briareus.service
```

`briareus.service` is whatever unit you wrote to run `npm start` on your own
machine; this repo ships no unit for the app itself, since the checkout path,
the user it runs as and the tunnel in front of it are all yours to decide.

There is nothing to build: `node server.js` runs the source as it is, and the
server has no frontend to compile.

## Outbound proxy

Voice transcription and generation use Node's built-in `fetch`. Setting
`HTTPS_PROXY` alone does not enable proxy support: on Node 24.5 or later, also
set `NODE_USE_ENV_PROXY=1` before starting the server, as described in
[Node's proxy documentation](https://nodejs.org/docs/latest-v24.x/api/http.html#built-in-proxy-support).
Briareus's `.env` parser does not configure Node's networking; these variables
must be in the process environment at startup.

For an existing user-level `briareus.service`, start with the examples below
if you have no proxy configuration yet; otherwise update your existing proxy
environment file and keep its address and service dependencies:

```bash
install -d -m 700 "$HOME/.config/briareus"
install -m 600 deploy/proxy.env.example "$HOME/.config/briareus/proxy.env"
```

Edit that file to use your proxy's address, and add internal HTTP services'
hostnames and LAN IPs to both `NO_PROXY` and `no_proxy`. Node gives lowercase
variables precedence, so keep both forms consistent. The setting applies to
the core's outbound HTTP requests, including transcription, voice generation,
GitHub, and object storage; internal services must bypass the proxy.

Install the drop-in to load the file when the service starts:

```bash
install -D -m 644 deploy/briareus-proxy.conf "$HOME/.config/systemd/user/briareus.service.d/node-proxy.conf"
systemctl --user daemon-reload
```

For a system-level service, use `/etc/systemd/system/briareus.service.d/` and
replace `%h` in the drop-in with the absolute home path of the service user.
For a shell launch, export the variables before `npm start`; for Docker, pass
them into the app container's environment and use a proxy address reachable
from inside that container.

Preparing the file and reloading systemd leaves the running server unchanged.
Restart only when sessions can be interrupted:

```bash
systemctl --user restart briareus.service
curl --fail http://127.0.0.1:4300/healthz
```

Then transcribe a short voice note and check access to internal HTTP services.
To roll back, restore the previous environment file or remove the example's
proxy variables, then restart at a suitable time.

## Shared browser with a virtual display

Set `BROWSER_DISPLAY=:98` and `BROWSER_BIN=/usr/bin/google-chrome` in the
server's `.env` to run the shared browser with a GUI. A nonempty
`BROWSER_DISPLAY` enables headed mode; Xvfb allocates a free display for each
session rather than using that value as a shared display address. Each browser
has its own authenticated X server and clipboard. The Browser panel and
Playwright continue to use the same CDP connection and session profiles.
Leave `BROWSER_DISPLAY` unset to run headless.

On Ubuntu, install Xvfb and its runtime dependencies with
`sudo apt-get install xvfb xauth`. Briareus uses
`~/.local/share/briareus-xvfb/usr/bin/Xvfb` when present, otherwise `Xvfb` on
PATH. If the dependencies are already installed, extract the Ubuntu package
without root instead:

```bash
task_xvfb_dir=$(mktemp -d)
(cd "$task_xvfb_dir" && apt-get download xvfb)
mkdir -p "$HOME/.local/share/briareus-xvfb"
for package in "$task_xvfb_dir"/*.deb; do
  dpkg-deb -x "$package" "$HOME/.local/share/briareus-xvfb"
done
rm -rf "$task_xvfb_dir"
```

Briareus starts and stops each display with its browser, stores a private
cookie in that session's profile, and disables TCP access. If you installed
the earlier shared display service, disable it:

```bash
systemctl --user disable --now briareus-browser-display.service
```

Deploy the code and restart Briareus after setting the two `.env` values.
Reopen the session's Browser panel to launch Chrome in the new mode. If Xvfb
or xauth is unavailable, startup fails rather than falling back to a shared
display or headless mode. This setup does not guarantee access to sites that
block the browser or the server's network.

# Pool databases in RAM

The eight pool instances (`mysql-pool@3307` … `mysql-pool@3314`) keep their
datadir on tmpfs instead of disk, so a session's database, whatever the project
points at, is memory and nothing else. A reboot leaves
none of it behind, and the next session gets a server that has never held
anybody's data.

Nothing is lost by that. The app already treats a pool server as disposable: it
creates the session's database and restores the project's dump before the
session runs ([lib/dbpool.js](../lib/dbpool.js)), so an instance that comes up
empty is repopulated on first use.

**The master on 3306 stays on disk.** It holds Briareus's own database (session
history, projects, providers, prompt templates) and none of that is
meant to be disposable.

`scripts/mysql-pool-ram.sh` does the work; `mysql-pool-ram@<port>.service` runs
it at boot, and the drop-in makes every `mysql-pool@<port>` require it first.

## Install

```bash
sudo install -m 755 scripts/mysql-pool-ram.sh /usr/local/bin/mysql-pool-ram
sudo install -m 644 deploy/mysql-pool-ram@.service /etc/systemd/system/
sudo install -m 644 -D deploy/mysql-pool-ram.conf /etc/systemd/system/mysql-pool@.service.d/ram.conf
sudo systemctl daemon-reload
sudo systemctl enable mysql-pool-ram@{3307,3308,3309,3310,3311,3312,3313,3314}.service
```

Re-run the first line after changing the script; the copy is what runs.

Then move the running pool over without waiting for a reboot:

```bash
sudo /usr/local/bin/mysql-pool-ram reset
```

That stops each instance, mounts its tmpfs, initializes a datadir into it and
starts it again. Any session open at that moment loses its database, so do it
when the board is idle.

## Reclaiming the old disk datadirs

The tmpfs mounts over `/var/lib/mysql-pool/<port>`, which hides the on-disk
datadirs rather than removing them: about 1.5 GB that is now invisible and
unused. Once the pool has run in RAM long enough to trust it:

```bash
sudo /usr/local/bin/mysql-pool-ram down          # unmounts, revealing the old dirs
sudo rm -rf /var/lib/mysql-pool/33{07,08,09,10,11,12,13,14}/{data,tmp,my.cnf,init.sql,error.log}
sudo /usr/local/bin/mysql-pool-ram reset
```

## Watching it

```bash
/usr/local/bin/mysql-pool-ram status
```

Per instance: whether mysqld is up, whether the datadir is `tmpfs` or `disk`,
and how much of the cap it is using. `journalctl -u mysql-pool-ram@3307` has the
boot-time initialization.

## Memory

Each instance caps its tmpfs at `RAM_SIZE` (3G) and its buffer pool at
`BUFFER_POOL` (512M). The cap is a ceiling, not a reservation (tmpfs holds only
the pages written) but it is a ceiling eight times over, so eight instances can
in principle reach 24 GB before they start failing writes. Size the pool against
the RAM you actually have. In practice an empty instance is ~190 MB and a
restored project dump adds a few hundred more, which puts eight of them near
4 GB.

Both knobs are environment variables read by the script, so a smaller machine
sets them in a drop-in rather than by editing the file:

```ini
[Service]
Environment=RAM_SIZE=1500M
Environment=BUFFER_POOL=256M
```

## Resetting one instance

```bash
sudo /usr/local/bin/mysql-pool-ram reset 3309
```

A crash does not do this: systemd restarting a failed mysqld finds the tmpfs
still mounted and the datadir intact, so a session survives its server dying.
Only a reboot, or this command, throws the data away.
