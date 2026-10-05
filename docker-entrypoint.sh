#!/bin/sh
# Container start for Heldover.
#
# The app must not run as root, but it has to write to /data, and on a normal
# Linux host Docker creates a missing "./data" folder owned by root. So the
# container starts as root, hands the data folder to the user the app runs as,
# then gives up root for good before the app starts.
#
#   PUID / PGID   the user and group the app runs as and that own its files
#                 (default 1000 and 1000). Unraid uses 99 and 100; Synology
#                 users are 1026 and up.
#
# Started as a non-root user already ("user:" in compose, or "docker run
# --user")? Then there is nothing to hand over and no root to give up: the app
# just runs as that user, who must be able to write the data folder.
set -eu

DATA_DIR="${DATA_DIR:-/data}"

# tini stays in front of the app either way: it reaps the ffmpeg children and
# passes "stop" on to node.
if [ "$(id -u)" != "0" ]; then
  exec /usr/bin/tini -- "$@"
fi

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
for value in "$PUID" "$PGID"; do
  case "$value" in
    '' | *[!0-9]*)
      echo "PUID and PGID must be numbers (got PUID=\"$PUID\" PGID=\"$PGID\")." >&2
      exit 1
      ;;
  esac
done

# No passwd entry is needed for the chosen ids, so the extra groups are cleared
# rather than looked up.
as_app() {
  setpriv --reuid="$PUID" --regid="$PGID" --clear-groups "$@"
}

mkdir -p "$DATA_DIR"

# Asked as the app's user, because root can write anywhere. Looks at the folder
# and the files directly in it (settings, database), which also catches a
# folder left behind by an earlier run under a different PUID. When everything
# is already writable nothing is touched, so a large poster cache is not
# walked on every start.
if [ -n "$(as_app find "$DATA_DIR" -maxdepth 1 ! -writable -print -quit 2>&1)" ]; then
  echo "Giving the data folder $DATA_DIR to user $PUID:$PGID."
  if ! chown -R "$PUID:$PGID" "$DATA_DIR"; then
    echo "Could not change the owner of $DATA_DIR. If it is a network share or mounted read-only, make it writable by user $PUID on the host." >&2
  fi
fi

# A home folder the app's user can use, instead of root's.
if [ "$PUID" = "$(id -u node)" ]; then
  export HOME=/home/node
else
  export HOME=/tmp
fi

exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups /usr/bin/tini -- "$@"
