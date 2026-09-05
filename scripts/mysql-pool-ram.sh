#!/usr/bin/env bash
#
# Puts a pool MySQL instance's datadir on tmpfs, so the whole instance lives in
# RAM and a reboot leaves nothing of it behind. Driven by mysql-pool-ram@.service
# (see deploy/), which every mysql-pool@<port> now requires. Nothing here
# assumes systemd, so it is also the thing to run by hand:
#
#   sudo /usr/local/bin/mysql-pool-ram init 3307    # mount + initialize if empty
#   sudo /usr/local/bin/mysql-pool-ram down 3307    # stop mysqld, unmount, discard
#   sudo /usr/local/bin/mysql-pool-ram reset 3307   # down + init + start mysqld
#        /usr/local/bin/mysql-pool-ram status       # what is in RAM right now
#
# Only the pool servers (3307-3314) are treated this way. The master on 3306
# holds the reviewer's own database (sessions, projects, providers, templates)
# and stays on disk.
#
# `init` is deliberately idempotent: with a datadir already initialized it does
# nothing. The wipe is not something this script performs on a schedule, it is
# what an empty tmpfs means after a boot, so a mysqld that crashes and is
# restarted by systemd comes back to the data its session was using, while a
# reboot starts every instance from nothing. The app fills them back in: it
# creates the session's database and restores the project's dump before the
# session runs (lib/dbpool.js).

set -euo pipefail

POOL_DATA=${POOL_DATA:-/var/lib/mysql-pool}
PORTS=${PORTS:-"3307 3308 3309 3310 3311 3312 3313 3314"}
# Same credential the rest of the pool tooling and the reviewer's db_servers
# rows expect on these instances.
POOL_PASS=${POOL_PASS:-123456}
MYSQLD_BIN=${MYSQLD_BIN:-/usr/sbin/mysqld}

# A cap, not a reservation: tmpfs only holds the pages actually written, so this
# is the ceiling one runaway instance may reach before it starts failing writes
# instead of eating the machine's memory. An empty 8.4 instance is ~190M and a
# restored project dump has been running around 300M on top of that.
RAM_SIZE=${RAM_SIZE:-3G}

# Lower than the 1G the on-disk instances use, and not a downgrade: the datadir
# is already RAM, so every page the buffer pool caches is a second copy of a
# page that was never going to cost a disk read. The pool is now only worth what
# InnoDB gets out of its own in-memory format.
BUFFER_POOL=${BUFFER_POOL:-512M}

# How many table definitions an instance may hold open before it starts evicting
# them. See write_config for why the 8.4 default is too low here.
TABLE_DEF_CACHE=${TABLE_DEF_CACHE:-20000}

log() { echo "[mysql-pool-ram] $*"; }
die() { echo "[mysql-pool-ram] ERROR: $*" >&2; exit 1; }

need_root() { [ "$(id -u)" -eq 0 ] || die "run as root"; }

valid_port() {
  for p in $PORTS; do [ "$p" = "$1" ] && return 0; done
  die "port $1 is not in the pool ($PORTS)"
}

write_config() { # write_config <port>
  local port=$1 inst="$POOL_DATA/$1"

  # init-file rather than the two-step "start it, then ALTER USER" the disk
  # instances use: --initialize-insecure leaves root without a password, and on
  # tmpfs that window reopens on every boot. mysqld ignores the file while
  # initializing and runs it on each real start, so the password is set before
  # the port ever accepts a connection.
  cat > "$inst/init.sql" <<SQL
ALTER USER 'root'@'localhost' IDENTIFIED BY '$POOL_PASS';
SQL

  cat > "$inst/my.cnf" <<CNF
[mysqld]
datadir=$inst/data
tmpdir=$inst/tmp
socket=$inst/mysqld.sock
port=$port
mysqlx=0
log-error=$inst/error.log
pid-file=$inst/mysqld.pid
server-id=$port
init-file=$inst/init.sql
innodb_buffer_pool_size=$BUFFER_POOL
max_connections=150
bind-address=127.0.0.1

# 8.4 autosizes this to 2000, which a pool instance passes with about sixteen
# session databases of a modular Laravel app on it. Past the cap MySQL evicts
# definitions, and a prepared statement whose table went with them fails with
# "1615 Prepared statement needs to be re-prepared": no retry in PDO, so it
# surfaces as a QueryException that kills a seeder halfway through. Definitions
# are small (the cost is one open table share per entry), so buy enough headroom
# that a pool instance never reaches it.
table_definition_cache=$TABLE_DEF_CACHE

# tmpfs cannot open files O_DIRECT. 8.4 defaults to fsync on Linux and would be
# fine, but the default is not a promise and a wrong one here fails at startup.
innodb_flush_method=fsync

# Durability is the thing this instance has traded away on purpose: nothing it
# holds is meant to survive the process, so the writes that exist to make a
# crash recoverable are pure overhead. The binary log especially: nothing
# replicates from these, and it is the largest thing 8.4 turns on by default.
innodb_flush_log_at_trx_commit=0
innodb_doublewrite=0
skip-log-bin

[client]
port=$port
protocol=tcp
CNF

  chown mysql:mysql "$inst/my.cnf" "$inst/init.sql"
}

cmd_init() { # cmd_init <port>
  need_root
  local port=$1 inst="$POOL_DATA/$1"
  valid_port "$port"

  # The mountpoint itself is a real directory on disk; everything below it stops
  # existing the moment the tmpfs is mounted over it.
  install -d -o mysql -g mysql -m 0750 "$inst"
  if ! mountpoint -q "$inst"; then
    mount -t tmpfs -o "size=$RAM_SIZE,mode=0750,uid=mysql,gid=mysql" "ram-mysql-$port" "$inst"
    log "[$port] tmpfs mounted on $inst ($RAM_SIZE cap)"
  fi

  if [ -d "$inst/data/mysql" ]; then
    log "[$port] datadir already initialized, leaving it alone"
    return 0
  fi

  install -d -o mysql -g mysql -m 0750 "$inst/tmp"
  write_config "$port"

  # --initialize-insecure refuses a datadir that already exists with content;
  # after a boot there is nothing here, but a half-written one from a failed
  # attempt would otherwise wedge every later start.
  rm -rf "$inst/data"

  log "[$port] initializing a fresh datadir in RAM..."
  if ! sudo -u mysql "$MYSQLD_BIN" --defaults-file="$inst/my.cnf" --initialize-insecure; then
    tail -5 "$inst/error.log" 2>/dev/null | sed 's/^/    /'
    die "[$port] initialization failed"
  fi
  log "[$port] ready (root/$POOL_PASS)"
}

cmd_down() { # cmd_down <port>
  need_root
  local port=$1 inst="$POOL_DATA/$1"
  valid_port "$port"

  systemctl stop "mysql-pool@$port" 2>/dev/null || true
  if mountpoint -q "$inst"; then
    # Lazy as the fallback only: a plain umount failing means something still
    # holds the datadir open, and detaching it is better than leaving the caller
    # to guess why the next init found a populated directory.
    umount "$inst" 2>/dev/null || umount -l "$inst"
    log "[$port] tmpfs unmounted, everything it held is gone"
  fi
}

cmd_reset() { # cmd_reset <port>
  need_root
  local port=$1
  valid_port "$port"
  cmd_down "$port"
  cmd_init "$port"
  systemctl start "mysql-pool@$port"
  log "[$port] restarted on an empty datadir"
}

cmd_status() {
  # findmnt rather than mountpoint: the datadirs are 0750 mysql:mysql, so an
  # unprivileged caller cannot stat them and mountpoint would report every
  # instance as being on disk: the one answer this command exists to give, and
  # the most alarming one to get wrong. findmnt reads /proc/self/mountinfo and
  # needs no access to the path at all.
  local blind=no
  printf '%-6s %-9s %-9s %-8s %s\n' PORT MYSQLD MOUNT USED SIZE
  for port in $PORTS; do
    local inst="$POOL_DATA/$port" state mount used size
    state=$(systemctl is-active "mysql-pool@$port" 2>/dev/null || true)
    if findmnt -rn --mountpoint "$inst" >/dev/null 2>&1; then
      mount=tmpfs
      # The sizes do need to stat the mount, so they are the part that stays
      # unknown without root.
      if used=$(df -h --output=used "$inst" 2>/dev/null | tail -1 | tr -d ' '); then
        size=$(df -h --output=size "$inst" 2>/dev/null | tail -1 | tr -d ' ')
      else
        used='?'
        size='?'
        blind=yes
      fi
    else
      mount=disk
      used=-
      size=-
    fi
    printf '%-6s %-9s %-9s %-8s %s\n' "$port" "${state:-unknown}" "$mount" "$used" "$size"
  done
  [ "$blind" = yes ] && echo "(run with sudo for the used/size columns)"
  return 0
}

# Every command but status takes a port; with none given they apply to the whole
# pool, which is what the by-hand "start over" is.
main() {
  local action=${1:-status}
  shift || true
  case "$action" in
    status) cmd_status ;;
    init | down | reset)
      local targets=("$@")
      [ ${#targets[@]} -gt 0 ] || read -ra targets <<<"$PORTS"
      for port in "${targets[@]}"; do "cmd_$action" "$port"; done
      ;;
    *) die "unknown command '$action' (init | down | reset | status)" ;;
  esac
}

main "$@"
