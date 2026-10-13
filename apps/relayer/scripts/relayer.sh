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

# Status uses public command-line identity and the launching environment.
# It deliberately does not load the signing application's env file.
if [ "${1-}" = "status" ]; then
  status_source=auto

  # Inspect option structure without changing the original arguments.
  # Node remains responsible for value validation and usage diagnostics.
  inspect_status_arguments() {
    shift
    status_source_seen=false

    while [ "$#" -gt 0 ]; do
      case "$1" in
        --chain-id|--signer|--source|--max-age-ms)
          status_option=$1

          if [ "$#" -lt 2 ]; then
            return 1
          fi

          case "$2" in
            --*)
              return 1
              ;;
          esac

          if [ "$status_option" = "--source" ]; then
            if [ "$status_source_seen" = true ]; then
              return 1
            fi

            status_source_seen=true

            case "$2" in
              journal|daemon-snapshot)
                status_source=$2
                ;;
              *)
                return 1
                ;;
            esac
          fi

          shift 2
          ;;
        *)
          return 1
          ;;
      esac
    done
  }

  if ! inspect_status_arguments "$@"; then
    exec node "$app_dir/dist/bootstrap.js" "$@"
  fi

  # Explicit snapshot mode requires neither flock nor an existing directory.
  if [ "$status_source" = "daemon-snapshot" ]; then
    exec node "$app_dir/dist/bootstrap.js" "$@"
  fi

  if ! status_flock_version=$(flock --version 2>/dev/null); then
    printf '%s\n' 'util-linux flock is required.' >&2
    exit 1
  fi

  case "$status_flock_version" in
    *util-linux*)
      ;;
    *)
      printf '%s\n' 'util-linux flock is required.' >&2
      exit 1
      ;;
  esac

  status_directory=${QUICKNET_STATE_DIR-./state}

  if [ -z "$status_directory" ]; then
    printf '%s\n' 'The relayer state directory must not be empty.' >&2
    exit 1
  fi

  if ! status_directory=$(
    CDPATH= cd -- "$status_directory" 2>/dev/null && pwd -P
  ); then
    printf '%s\n' 'Unable to resolve the existing relayer state directory.' >&2
    exit 1
  fi

  export QUICKNET_STATE_DIR="$status_directory"
  status_lock="$status_directory/relayer.flock"

  # Do not create, truncate, or follow a lock-file symlink.
  if [ -L "$status_lock" ] || [ ! -f "$status_lock" ]; then
    printf '%s\n' 'Status requires an existing regular service lock file.' >&2
    exit 1
  fi

  if ! status_links=$(stat -c '%h' -- "$status_lock" 2>/dev/null); then
    printf '%s\n' 'Unable to validate the service lock file.' >&2
    exit 1
  fi

  if [ "$status_links" != 1 ]; then
    printf '%s\n' 'The service lock file must have one hard link.' >&2
    exit 1
  fi

  # Read-only opening preserves the existing lock file.
  # Node verifies ownership and the opened inode before journal inspection.
  exec 9<"$status_lock"

  if flock --exclusive --nonblock --conflict-exit-code 75 9; then
    if [ "$status_source" = auto ]; then
      set -- "$@" --source journal
    fi

    exec node "$app_dir/dist/bootstrap.js" "$@"
  else
    status_lock_exit=$?
  fi

  # Snapshot mode must not inherit the unsuccessful lock descriptor.
  exec 9<&-

  if [ "$status_source" = auto ] && [ "$status_lock_exit" -eq 75 ]; then
    exec node "$app_dir/dist/bootstrap.js" "$@" --source daemon-snapshot
  fi

  # Explicit journal contention and all other acquisition errors remain errors.
  exit "$status_lock_exit"
fi

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

# Reserve a descriptor outside stdin, stdout, and stderr.
# Append mode creates a missing file without truncating an existing one.
# Never unlink the persistent lock file while writers may be running.
exec 9>>"$state_dir/relayer.flock"

# flock locks the shared open file description and then exits.
# The shell retains ownership through fd 9.
# Preserve exit 75 for contention and other acquisition error statuses.
flock \
  --exclusive \
  --nonblock \
  --conflict-exit-code 75 \
  9 || exit $?

# Replace the shell so Node receives signals directly and inherits fd 9
exec node "$@"