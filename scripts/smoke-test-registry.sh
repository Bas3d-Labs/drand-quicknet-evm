#!/usr/bin/env bash
set -euo pipefail

MANIFEST="deployments/robinhood-testnet.json"
: "${ROBINHOOD_TESTNET_RPC_URL:?Missing ROBINHOOD_TESTNET_RPC_URL}"
: "${PRIVATE_KEY:?Missing PRIVATE_KEY}"

RPC_URL="$ROBINHOOD_TESTNET_RPC_URL"
REGISTRY=$(jq -r '.registry.address' "$MANIFEST")
ORACLE=$(jq -r '.oracle.address' "$MANIFEST")
EXPECTED_CHAIN_ID=$(jq -r '.chainId' "$MANIFEST")
ACTUAL_CHAIN_ID=$(cast chain-id --rpc-url "$RPC_URL")

if [ "$ACTUAL_CHAIN_ID" != "$EXPECTED_CHAIN_ID" ]; then
  echo "Wrong chain: expected $EXPECTED_CHAIN_ID, got $ACTUAL_CHAIN_ID"
  exit 1
fi

echo "Registry: $REGISTRY"
echo "Oracle:   $ORACLE"
echo "Chain:    $ACTUAL_CHAIN_ID"

LATEST=$(
  cast call \
    "$REGISTRY" \
    "latestScheduledRound()(uint64)" \
    --rpc-url "$RPC_URL" |
  awk '{print $1}'
)
TARGET=$((LATEST + 2))

echo "Latest:   $LATEST"
echo "Target:   $TARGET"

ALREADY_STORED=$(
  cast call \
    "$REGISTRY" \
    "isStored(uint64)(bool)" \
    "$TARGET" \
    --rpc-url "$RPC_URL" |
  awk '{print $1}'
)

if [ "$ALREADY_STORED" = "true" ]; then
  echo "Target round already stored; choose another round"
  exit 1
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
  echo "Failed to fetch Quicknet round $TARGET"
  exit 1
fi

RETURNED_ROUND=$(echo "$BEACON" | jq -r '.round')
SIGNATURE_HEX=$(echo "$BEACON" | jq -r '.signature')

if [ "$RETURNED_ROUND" != "$TARGET" ]; then
  echo "Wrong drand round: expected $TARGET, got $RETURNED_ROUND"
  exit 1
fi

if [ "${#SIGNATURE_HEX}" -ne 96 ]; then
  echo "Unexpected compressed signature length"
  exit 1
fi

SIGNATURE="0x$SIGNATURE_HEX"
echo "Signature: $SIGNATURE"
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

IS_STORED=$(
  cast call \
    "$REGISTRY" \
    "isStored(uint64)(bool)" \
    "$TARGET" \
    --rpc-url "$RPC_URL" |
  awk '{print $1}'
)
if [ "$IS_STORED" != "true" ]; then
  echo "Beacon was not stored"
  exit 1
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