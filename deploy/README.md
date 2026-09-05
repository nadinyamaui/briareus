# Deploying

By hand, on purpose: nothing polls GitHub and nothing restarts the server on
its own, so a commit landing on `main` never picks the moment the live checkout
changes under whoever is using it.

```bash
cd /path/to/briareus
git pull --ff-only
npm ci                     # only when package-lock.json moved
npm run build:css          # every pull: the stylesheet is not committed
sudo systemctl restart briareus.service
```

`briareus.service` is whatever unit you wrote to run `npm start` on your own
machine; this repo ships no unit for the app itself, since the checkout path,
the user it runs as and the tunnel in front of it are all yours to decide.

`public/app.css` is Tailwind output and is not committed, so the pull carries
the source and not the CSS: `npm run build:css` is what turns one into the
other, and `node server.js` never does it for you. Tailwind is a dev
dependency, so the install this checkout runs has to be a plain `npm ci` and
not `--omit=dev` (and `NODE_ENV=production` in the shell would quietly make it
one). The container deploy has no such step: the image builds the stylesheet
in a stage of its own.

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
