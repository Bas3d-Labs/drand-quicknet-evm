#!/bin/sh
set -eu

# Installed bin entries may reach this script through a symlink.
if ! self=$(readlink -f -- "$0"); then
  printf '%s\n' 'Unable to resolve the relayer launcher.' >&2
  exit 1
fi

app_dir=$(CDPATH= cd -- "$(dirname -- "$self")/.." && pwd -P)

if [ "${1-}" = "--" ]; then
  shift
fi

# Help needs neither application configuration nor service ownership.
case "${1-}" in
  ''|help)
    exec node "$app_dir/dist/bootstrap.js" "$@"
    ;;
esac

for argument in "$@"; do
  case "$argument" in
    -h|--help)
      exec node "$app_dir/dist/bootstrap.js" "$@"
      ;;
  esac
done

# Reject incompatible implementations before creating state files.
if ! flock_version=$(flock --version 2>/dev/null); then
  printf '%s\n' 'util-linux flock is required.' >&2
  exit 1
fi

case "$flock_version" in
  *util-linux*)
    ;;
  *)
    printf '%s\n' 'util-linux flock is required.' >&2
    exit 1
    ;;
esac

umask 077

# Default only when unset. An explicitly empty value is invalid.
state_dir=${QUICKNET_STATE_DIR-./state}

if [ -z "$state_dir" ]; then
  printf '%s\n' 'The relayer state directory must not be empty.' >&2
  exit 1
fi

if ! mkdir -p -- "$state_dir" 2>/dev/null; then
  printf '%s\n' 'Unable to prepare the relayer state directory.' >&2
  exit 1
fi

if ! state_dir=$(
  CDPATH= cd -- "$state_dir" 2>/dev/null && pwd -P
); then
  printf '%s\n' 'Unable to resolve the relayer state directory.' >&2
  exit 1
fi

export QUICKNET_STATE_DIR="$state_dir"

# An explicitly configured application env file is required to exist.
# Help deliberately bypasses loading it
if [ -n "${QUICKNET_ENV_FILE-}" ]; then
  set -- "--env-file=$QUICKNET_ENV_FILE" \
    "$app_dir/dist/bootstrap.js" "$@"
else
  set -- "$app_dir/dist/bootstrap.js" "$@"
fi

# Both exec operations preserve direct signal delivery to Node.
# Exit 75 means contention. It can occur without a diagnostic message.
# Never unlink the persistent lock file while writers may be running.
exec flock \
  --exclusive \
  --nonblock \
  --no-fork \
  --conflict-exit-code 75 \
  "$state_dir/relayer.flock" \
  node "$@"