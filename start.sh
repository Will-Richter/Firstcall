#!/bin/sh
# Starts Firstcall inside its container. See the note in the Dockerfile.
set -e
DATA="${DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA"
  chown -R node:node "$DATA"
  exec setpriv --reuid=node --regid=node --init-groups node --disable-warning=ExperimentalWarning server.js
fi
exec node --disable-warning=ExperimentalWarning server.js
