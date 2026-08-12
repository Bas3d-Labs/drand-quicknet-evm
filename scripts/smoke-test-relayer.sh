#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(
  cd "$(dirname "${BASH_SOURCE[0]}")" &&
  pwd
)
ROOT_DIR=$(
  cd "$SCRIPT_DIR/.." &&
  pwd
)

ENV_FILE="$ROOT_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  set -a

  # shellcheck disable=SC1090
  source "$ENV_FILE"

  set +a
fi

NETWORK="robinhood-testnet"
DEPLOYMENT_FILE="$ROOT_DIR/deployments/robinhood-testnet.json"

cd "$ROOT_DIR"

CUSTOM_NETWORK_CONFIG="${CUSTOM_NETWORK_CONFIG:-networks/examples/robinhood-testnet-custom.json}"
LEAD_ROUNDS="${QUICKNET_SMOKE_LEAD_ROUNDS:-5}"
RELAYER_PACKAGE="@based-labs/drand-quicknet-relayer"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

info() {
  echo
  echo "==> $*"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 ||
    fail "Required command not found: $1"
}

require_env() {
  local name="$1"
  [[ -n "${!name:-}" ]] ||
    fail "Required environment variable is not set: $name"
}

read_uint() {
  # `cast call` may annotate integer output depending on Foundry version.
  # We only want the first whitespace-delimited decimal value.
  awk '{ print $1 }'
}

registry_is_stored() {
  local round="$1"

  cast call \
    "$REGISTRY_ADDRESS" \
    "isStored(uint64)(bool)" \
    "$round" \
    --rpc-url "$ROBINHOOD_TESTNET_RPC_URL"
}

registry_get_beacon() {
  local round="$1"

  cast call \
    "$REGISTRY_ADDRESS" \
    "getBeacon(uint64)(bytes32)" \
    "$round" \
    --rpc-url "$ROBINHOOD_TESTNET_RPC_URL"
}

relayer() {
  pnpm --filter "$RELAYER_PACKAGE" start "$@"
}

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------

require_command pnpm
require_command jq
require_command cast

require_env ROBINHOOD_TESTNET_RPC_URL
require_env PRIVATE_KEY

[[ -f "$CUSTOM_NETWORK_CONFIG" ]] ||
  fail "Custom network config not found: $CUSTOM_NETWORK_CONFIG"

[[ -f "$DEPLOYMENT_FILE" ]] ||
  fail "Deployment manifest not found: $DEPLOYMENT_FILE"

REGISTRY_ADDRESS="$(
  jq -er '.registry.address' "$DEPLOYMENT_FILE"
)" || fail "Could not read .registry.address from $DEPLOYMENT_FILE"

EXPECTED_CHAIN_ID="$(
  jq -er '.chainId' "$DEPLOYMENT_FILE"
)" || fail "Could not read .chainId from $DEPLOYMENT_FILE"

ACTUAL_CHAIN_ID="$(
  cast chain-id --rpc-url "$ROBINHOOD_TESTNET_RPC_URL"
)"

[[ "$ACTUAL_CHAIN_ID" == "$EXPECTED_CHAIN_ID" ]] ||
  fail "Wrong chain: expected $EXPECTED_CHAIN_ID, got $ACTUAL_CHAIN_ID"

SIGNER_ADDRESS="$(
  cast wallet address --private-key "$PRIVATE_KEY"
)"

info "Relayer live smoke test"
echo "Network:   $NETWORK"
echo "Chain ID:  $ACTUAL_CHAIN_ID"
echo "Registry:  $REGISTRY_ADDRESS"
echo "Signer:    $SIGNER_ADDRESS"

# ---------------------------------------------------------------------------
# Pick a fresh future Quicknet round
# ---------------------------------------------------------------------------

LATEST="$(
  cast call \
    "$REGISTRY_ADDRESS" \
    "latestScheduledRound()(uint64)" \
    --rpc-url "$ROBINHOOD_TESTNET_RPC_URL" |
    read_uint
)"

[[ "$LATEST" =~ ^[0-9]+$ ]] ||
  fail "Unexpected latestScheduledRound output: $LATEST"

TARGET_ROUND=$((LATEST + LEAD_ROUNDS))

info "Selected future round $TARGET_ROUND"
echo "Latest scheduled: $LATEST"
echo "Lead rounds:     $LEAD_ROUNDS"

STORED_BEFORE="$(registry_is_stored "$TARGET_ROUND")"

[[ "$STORED_BEFORE" == "false" ]] ||
  fail "Target round $TARGET_ROUND is already stored; rerun the smoke test"

NONCE_BEFORE="$(
  cast nonce \
    "$SIGNER_ADDRESS" \
    --rpc-url "$ROBINHOOD_TESTNET_RPC_URL"
)"

# ---------------------------------------------------------------------------
# 1. Future-round import through official preset
# ---------------------------------------------------------------------------

info "1/3 import-when-available via official preset"

relayer \
  import-when-available \
  --network "$NETWORK" \
  --round "$TARGET_ROUND"

STORED_AFTER_WRITE="$(registry_is_stored "$TARGET_ROUND")"

[[ "$STORED_AFTER_WRITE" == "true" ]] ||
  fail "Round $TARGET_ROUND was not stored after import-when-available"

BEACON_AFTER_WRITE="$(registry_get_beacon "$TARGET_ROUND")"

[[ "$BEACON_AFTER_WRITE" =~ ^0x[0-9a-fA-F]{64}$ ]] ||
  fail "Unexpected beacon value: $BEACON_AFTER_WRITE"

NONCE_AFTER_WRITE="$(
  cast nonce \
    "$SIGNER_ADDRESS" \
    --rpc-url "$ROBINHOOD_TESTNET_RPC_URL"
)"

EXPECTED_NONCE_AFTER_WRITE=$((NONCE_BEFORE + 1))

[[ "$NONCE_AFTER_WRITE" -eq "$EXPECTED_NONCE_AFTER_WRITE" ]] ||
  fail \
    "Expected exactly one signer transaction: nonce $NONCE_BEFORE -> $EXPECTED_NONCE_AFTER_WRITE, got $NONCE_AFTER_WRITE"

echo "Stored beacon: $BEACON_AFTER_WRITE"
echo "Signer nonce:  $NONCE_BEFORE -> $NONCE_AFTER_WRITE"

# ---------------------------------------------------------------------------
# 2. Same round through official preset: must be idempotent
# ---------------------------------------------------------------------------

info "2/3 import same round via official preset"

relayer \
  import \
  --network "$NETWORK" \
  --round "$TARGET_ROUND"

BEACON_AFTER_SECOND_IMPORT="$(registry_get_beacon "$TARGET_ROUND")"

[[ "$BEACON_AFTER_SECOND_IMPORT" == "$BEACON_AFTER_WRITE" ]] ||
  fail "Stored randomness changed after idempotent import"

NONCE_AFTER_SECOND_IMPORT="$(
  cast nonce \
    "$SIGNER_ADDRESS" \
    --rpc-url "$ROBINHOOD_TESTNET_RPC_URL"
)"

[[ "$NONCE_AFTER_SECOND_IMPORT" -eq "$NONCE_AFTER_WRITE" ]] ||
  fail "Idempotent import unexpectedly sent a transaction"

echo "Beacon unchanged."
echo "Signer nonce unchanged: $NONCE_AFTER_SECOND_IMPORT"

# ---------------------------------------------------------------------------
# 3. Same round through permissionless custom-network config
# ---------------------------------------------------------------------------

info "3/3 import same round via custom network config"

relayer \
  import \
  --network-config "$CUSTOM_NETWORK_CONFIG" \
  --round "$TARGET_ROUND"

BEACON_AFTER_CUSTOM_CONFIG="$(registry_get_beacon "$TARGET_ROUND")"

[[ "$BEACON_AFTER_CUSTOM_CONFIG" == "$BEACON_AFTER_WRITE" ]] ||
  fail "Custom-network config resolved to different stored randomness"

NONCE_AFTER_CUSTOM_CONFIG="$(
  cast nonce \
    "$SIGNER_ADDRESS" \
    --rpc-url "$ROBINHOOD_TESTNET_RPC_URL"
)"

[[ "$NONCE_AFTER_CUSTOM_CONFIG" -eq "$NONCE_AFTER_WRITE" ]] ||
  fail "Custom-config idempotent import unexpectedly sent a transaction"

echo "Beacon unchanged."
echo "Signer nonce unchanged: $NONCE_AFTER_CUSTOM_CONFIG"

# ---------------------------------------------------------------------------
# Success
# ---------------------------------------------------------------------------

info "PASS"
echo "Round:      $TARGET_ROUND"
echo "Randomness: $BEACON_AFTER_WRITE"
echo
echo "Verified:"
echo "   - official preset imported a fresh future round"
echo "   - registry contains the exact round"
echo "   - first operation caused exactly one signer transaction"
echo "   - repeated preset import was idempotent"
echo "   - custom-network import resolved to the same registry state"
echo "   - stored randomness never changed"