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
MANIFEST="deployments/robinhood-testnet.json"

if [ -f "$ENV_FILE" ]; then
  set -a

  # shellcheck disable=SC1090
  source "$ENV_FILE"

  set +a
fi

: "${ROBINHOOD_TESTNET_RPC_URL:?Missing ROBINHOOD_TESTNET_RPC_URL}"
: "${PRIVATE_KEY:?Missing PRIVATE_KEY}"

RPC_URL="$ROBINHOOD_TESTNET_RPC_URL"

REGISTRY=$(jq -r '.registry.address' "$MANIFEST")
EXPECTED_REGISTRY_CODEHASH=$(jq -r '.registry.runtimeCodehash' "$MANIFEST")
EXPECTED_REGISTRY_MIN_LEAD_ROUNDS=$(jq -r '.registry.minimumLeadRounds' "$MANIFEST")

VERIFIER=$(jq -r '.verifier.address' "$MANIFEST")
EXPECTED_VERIFIER_CODEHASH=$(jq -r '.verifier.runtimeCodehash' "$MANIFEST")

EXPECTED_CHAIN_ID=$(jq -r '.chainId' "$MANIFEST")

fail() {
  echo "$1"
  exit 1
}

# -------------------------------------------------------------------------
# Deployment verification
# -------------------------------------------------------------------------

ACTUAL_CHAIN_ID=$(
  cast chain-id \
    --rpc-url "$RPC_URL"
)

if [ "$ACTUAL_CHAIN_ID" != "$EXPECTED_CHAIN_ID" ]; then
  fail "Wrong chain: expected $EXPECTED_CHAIN_ID, got $ACTUAL_CHAIN_ID"
fi

ACTUAL_REGISTRY_CODEHASH=$(
  cast codehash \
    "$REGISTRY" \
    --rpc-url "$RPC_URL"
)

if [ "${ACTUAL_REGISTRY_CODEHASH,,}" != "${EXPECTED_REGISTRY_CODEHASH,,}" ]; then
  echo "Registry runtime codehash mismatch"
  echo "Expected: $EXPECTED_REGISTRY_CODEHASH"
  echo "Actual:   $ACTUAL_REGISTRY_CODEHASH"
  exit 1
fi

ACTUAL_VERIFIER_CODEHASH=$(
  cast codehash \
    "$VERIFIER" \
    --rpc-url "$RPC_URL"
)

if [ "${ACTUAL_VERIFIER_CODEHASH,,}" != "${EXPECTED_VERIFIER_CODEHASH,,}" ]; then
  echo "Verifier runtime codehash mismatch"
  echo "Expected: $EXPECTED_VERIFIER_CODEHASH"
  echo "Actual:   $ACTUAL_VERIFIER_CODEHASH"
  exit 1
fi

ACTUAL_REGISTRY_MIN_LEAD_ROUNDS=$(
  cast call "$REGISTRY" \
    "minimumLeadRounds()(uint64)" \
    --rpc-url "$ROBINHOOD_TESTNET_RPC_URL"
)

if [ "${EXPECTED_REGISTRY_MIN_LEAD_ROUNDS,,}" != "${ACTUAL_REGISTRY_MIN_LEAD_ROUNDS,,}" ]; then
  echo "Registry minimum lead rounds mismatch"
  echo "Expected: $EXPECTED_REGISTRY_MIN_LEAD_ROUNDS"
  echo "Actual:   $ACTUAL_REGISTRY_MIN_LEAD_ROUNDS"
  exit 1
fi

REGISTRY_VERIFIER=$(
  cast call \
    "$REGISTRY" \
    "verifier()(address)" \
    --rpc-url "$RPC_URL" |
  awk '{print $1}'
)

if [ "${REGISTRY_VERIFIER,,}" != "${VERIFIER,,}" ]; then
  echo "Registry verifier mismatch"
  echo "Expected: $VERIFIER"
  echo "Actual:   $REGISTRY_VERIFIER"
  exit 1
fi

REGISTRY_VERIFIER_CODEHASH=$(
  cast call \
    "$REGISTRY" \
    "verifierCodehash()(bytes32)" \
    --rpc-url "$RPC_URL" |
  awk '{print $1}'
)

if [ "${REGISTRY_VERIFIER_CODEHASH,,}" != "${EXPECTED_VERIFIER_CODEHASH,,}" ]; then
  echo "Registry verifier codehash mismatch"
  echo "Expected: $EXPECTED_VERIFIER_CODEHASH"
  echo "Actual:   $REGISTRY_VERIFIER_CODEHASH"
  exit 1
fi

echo "Chain:                    $ACTUAL_CHAIN_ID"
echo "Registry:                 $REGISTRY"
echo "Registry codehash:        $ACTUAL_REGISTRY_CODEHASH"
echo "Registry Min Lead Rounds: $ACTUAL_REGISTRY_MIN_LEAD_ROUNDS"
echo ""

echo "Verifier:                 $VERIFIER"
echo "Verifier codehash:        $ACTUAL_VERIFIER_CODEHASH"
echo ""

# -------------------------------------------------------------------------
# Select future Quicknet round
# -------------------------------------------------------------------------

LATEST=$(
  cast call \
    "$REGISTRY" \
    "latestScheduledRound()(uint64)" \
    --rpc-url "$RPC_URL" |
  awk '{print $1}'
)

TARGET=$((LATEST + 2))

echo "Latest:            $LATEST"
echo "Target:            $TARGET"

ALREADY_STORED=$(
  cast call \
    "$REGISTRY" \
    "isStored(uint64)(bool)" \
    "$TARGET" \
    --rpc-url "$RPC_URL" |
  awk '{print $1}'
)

if [ "$ALREADY_STORED" = "true" ]; then
  fail "Target round already stored; choose another round"
fi

SCHEDULED=$(
  cast call \
    "$REGISTRY" \
    "roundScheduledTime(uint64)(uint256)" \
    "$TARGET" \
    --rpc-url "$RPC_URL" |
  awk '{print $1}'
)

NOW=$(date +%s)
WAIT=$((SCHEDULED - NOW))

if [ "$WAIT" -gt 0 ]; then
  echo "Waiting $WAIT seconds for round $TARGET..."
  sleep "$WAIT"
fi

# Allow a small amount of publication latency.
sleep 1

# -------------------------------------------------------------------------
# Fetch exact drand beacon
# -------------------------------------------------------------------------

echo "Fetching Quicknet round $TARGET..."

BEACON=""

for attempt in {1..10}; do
  if RESPONSE=$(
    curl -fsS \
      "https://api.drand.sh/v2/beacons/quicknet/rounds/$TARGET"
  ); then
    BEACON="$RESPONSE"
    break
  fi

  echo "Beacon not available yet; retrying..."
  sleep 1
done

if [ -z "$BEACON" ]; then
  fail "Failed to fetch Quicknet round $TARGET"
fi

RETURNED_ROUND=$(echo "$BEACON" | jq -r '.round')
SIGNATURE_HEX=$(echo "$BEACON" | jq -r '.signature')

if [ "$RETURNED_ROUND" != "$TARGET" ]; then
  fail "Wrong drand round: expected $TARGET, got $RETURNED_ROUND"
fi

if [ "${#SIGNATURE_HEX}" -ne 96 ]; then
  fail "Unexpected compressed signature length"
fi

SIGNATURE="0x$SIGNATURE_HEX"

echo "Signature: $SIGNATURE"
echo ""

# -------------------------------------------------------------------------
# Simulate submission
# -------------------------------------------------------------------------

echo "Simulating registry submission..."

EXPECTED_RANDOMNESS=$(
  cast call \
    "$REGISTRY" \
    "submitBeacon(uint64,bytes)(bytes32)" \
    "$TARGET" \
    "$SIGNATURE" \
    --rpc-url "$RPC_URL" |
  awk '{print $1}'
)

echo "Randomness: $EXPECTED_RANDOMNESS"

# -------------------------------------------------------------------------
# Broadcast
# -------------------------------------------------------------------------

echo "Broadcasting..."

TX_JSON=$(
  cast send \
    "$REGISTRY" \
    "submitBeacon(uint64,bytes)" \
    "$TARGET" \
    "$SIGNATURE" \
    --private-key "$PRIVATE_KEY" \
    --rpc-url "$RPC_URL" \
    --json
)

TX_HASH=$(echo "$TX_JSON" | jq -r '.transactionHash')

echo "Transaction: $TX_HASH"

# -------------------------------------------------------------------------
# Verify resulting registry state
# -------------------------------------------------------------------------

IS_STORED=$(
  cast call \
    "$REGISTRY" \
    "isStored(uint64)(bool)" \
    "$TARGET" \
    --rpc-url "$RPC_URL" |
  awk '{print $1}'
)

if [ "$IS_STORED" != "true" ]; then
  fail "Beacon was not stored"
fi

STORED_RANDOMNESS=$(
  cast call \
    "$REGISTRY" \
    "getBeacon(uint64)(bytes32)" \
    "$TARGET" \
    --rpc-url "$RPC_URL" |
  awk '{print $1}'
)

if [ "${STORED_RANDOMNESS,,}" != "${EXPECTED_RANDOMNESS,,}" ]; then
  echo "Randomness mismatch"
  echo "Expected: $EXPECTED_RANDOMNESS"
  echo "Stored:   $STORED_RANDOMNESS"
  exit 1
fi

echo
echo "Smoke test passed"
echo "Round:      $TARGET"
echo "Randomness: $STORED_RANDOMNESS"
echo "Tx:         $TX_HASH"