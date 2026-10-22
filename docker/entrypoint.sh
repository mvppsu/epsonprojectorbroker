#!/bin/sh
set -e

# UNRAID (and most bind-mounted appdata setups) hand /config to the container with
# whatever ownership the host directory already has, which rarely matches the
# unprivileged "broker" user baked into the image. Running as root only long enough to
# fix that up avoids a broker that silently can't persist broker.yaml because of a UID
# mismatch it has no way to see, let alone recover from.
if [ "$(id -u)" = "0" ]; then
  mkdir -p /config
  chown -R broker:broker /config || true
  exec su-exec broker:broker "$@"
fi

exec "$@"
