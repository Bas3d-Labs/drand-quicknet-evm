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

if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ROOT_DIR/.env"
  set +a
fi

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

if [ "$#" -ne 1 ]; then
  fail "Usage: $0 <deployment-manifest>"
fi

MANIFEST="$1"

case "$MANIFEST" in
  /*) ;;
  *) MANIFEST="$ROOT_DIR/$MANIFEST" ;;
esac

[ -f "$MANIFEST" ] || fail "Manifest not found: $MANIFEST"

: "${QUICKNET_RPC_URL:?Set QUICKNET_RPC_URL to the target chain RPC}"
: "${PRIVATE_KEY:?Missing PRIVATE_KEY}"

RPC_URL="$QUICKNET_RPC_URL"

DEPLOYER=$(cast wallet address --private-key "$PRIVATE_KEY")

REGISTRY=$(jq -er '.registry.address' "$MANIFEST")
REGISTRY_CODEHASH=$(jq -er '.registry.runtimeCodehash' "$MANIFEST")
VERIFIER=$(jq -er '.verifier.address' "$MANIFEST")
VERIFIER_CODEHASH=$(jq -er '.verifier.runtimeCodehash' "$MANIFEST")
EXPECTED_CHAIN_ID=$(jq -er '.chainId' "$MANIFEST")

FIXTURE="$ROOT_DIR/contracts/test/fixtures/quicknet-kat.json"
GAS_LIMIT=2000000

WITNESS_FIRST_ROUND="${SMOKE_WITNESS_ROUND:-1000}"
COMPRESSED_FIRST_ROUND="${SMOKE_COMPRESSED_ROUND:-13335}"

if [ "$WITNESS_FIRST_ROUND" = "$COMPRESSED_FIRST_ROUND" ]; then
  fail "Witness and compressed checks require different rounds"
fi

COMPRESSED_METHOD="submitBeacon(uint64,bytes)"
WITNESS_METHOD="submitBeaconWithWitness(uint64,bytes,uint128,uint256)"

assert_equal() {
  local actual="$1"
  local expected="$2"
  local label="$3"

  if [ "${actual,,}" != "${expected,,}" ]; then
    fail "$label: expected $expected, got $actual"
  fi
}

registry_call() {
  cast call "$REGISTRY" "$@" \
    --from "$DEPLOYER" \
    --gas-limit "$GAS_LIMIT" \
    --rpc-url "$RPC_URL"
}

# -------------------------------------------------------------------------
# Authenticate the deployment
# -------------------------------------------------------------------------

CHAIN_ID=$(cast chain-id --rpc-url "$RPC_URL")

assert_equal "$CHAIN_ID" "$EXPECTED_CHAIN_ID" "Chain ID"

assert_equal \
  "$(cast codehash "$REGISTRY" --rpc-url "$RPC_URL")" \
  "$REGISTRY_CODEHASH" \
  "Registry codehash"

assert_equal \
  "$(cast codehash "$VERIFIER" --rpc-url "$RPC_URL")" \
  "$VERIFIER_CODEHASH" \
  "Verifier codehash"

assert_equal \
  "$(registry_call "verifier()(address)")" \
  "$VERIFIER" \
  "Registry verifier"

assert_equal \
  "$(registry_call "verifierCodehash()(bytes32)")" \
  "$VERIFIER_CODEHASH" \
  "Registry verifier codehash"

MINIMUM_LEAD_ROUNDS=$(
  registry_call "minimumLeadRounds()(uint64)" |
    awk '{print $1}'
)

# Chain-policy comparison belongs to the security profile.
printf 'Manifest:            %s\n' "$MANIFEST"
printf 'Chain:               %s\n' "$CHAIN_ID"
printf 'Deployer:            %s\n' "$DEPLOYER"
printf 'Registry:            %s\n' "$REGISTRY"
printf 'Verifier:            %s\n' "$VERIFIER"
printf 'Minimum lead rounds: %s\n\n' "$MINIMUM_LEAD_ROUNDS"

# -------------------------------------------------------------------------
# Fixture and assertion helpers
# -------------------------------------------------------------------------

load_fixture() {
  TARGET="$1"

  local vector
  local uncompressed
  local coordinates

  vector=$(
    jq -ce --arg round "$TARGET" '
      [.positive[] | select(.round == $round)]
      | if length == 1 then
          .[0]
        else
          error("Expected exactly one positive fixture")
        end
    ' "$FIXTURE"
  )

  SIGNATURE=$(jq -er '.signature' <<< "$vector")
  EXPECTED_RANDOMNESS=$(jq -er '.randomness' <<< "$vector")
  uncompressed=$(jq -er '.uncompressed' <<< "$vector")

  [ "${#SIGNATURE}" -eq 98 ] ||
    fail "Unexpected fixture signature length"

  [ "${#EXPECTED_RANDOMNESS}" -eq 66 ] ||
    fail "Unexpected fixture randomness length"

  [ "${#uncompressed}" -eq 194 ] ||
    fail "Unexpected fixture coordinate length"

  # Raw coordinates are 48-byte x followed by 48-byte y.
  coordinates="${uncompressed:2}"
  Y_HI="0x${coordinates:96:32}"
  Y_LO="0x${coordinates:128:64}"
}

require_unstored() {
  local stored

  stored=$(registry_call "isStored(uint64)(bool)" "$TARGET")

  [ "$stored" = "false" ] ||
    fail "Round $TARGET is already stored; use a fresh deployment"
}

check_cached_calls() {
  # Both methods must ignore invalid inputs once the round is stored.
  assert_equal \
    "$(registry_call "${COMPRESSED_METHOD}(bytes32)" "$TARGET" 0x)" \
    "$EXPECTED_RANDOMNESS" \
    "Cached compressed return"

  assert_equal \
    "$(registry_call "${WITNESS_METHOD}(bytes32)" "$TARGET" 0x 0 0)" \
    "$EXPECTED_RANDOMNESS" \
    "Cached witness return"

  printf 'PASS round %s: both cached-call simulations\n' "$TARGET"
}

submit_and_check() {
  local method="$1"
  shift

  local simulated
  local tx_hash
  local receipt
  local event_topic
  local round_topic
  local submitter_topic

  require_unstored

  simulated=$(registry_call "${method}(bytes32)" "$@")

  assert_equal \
    "$simulated" "$EXPECTED_RANDOMNESS" "Submission simulation"

  printf 'Submitting round %s with %s...\n' "$TARGET" "$method"

  tx_hash=$(
    cast send "$REGISTRY" "$method" "$@" \
      --private-key "$PRIVATE_KEY" \
      --gas-limit "$GAS_LIMIT" \
      --rpc-url "$RPC_URL" \
      --async
  )

  printf 'Transaction: %s\n' "$tx_hash"

  receipt=$(
    cast receipt "$tx_hash" --rpc-url "$RPC_URL" --json
  )

  event_topic=$(cast sig-event "BeaconStored(uint64,bytes32,address)")
  round_topic=$(cast abi-encode "f(uint64)" "$TARGET")
  submitter_topic=$(cast abi-encode "f(address)" "$DEPLOYER")

  if ! jq -e \
    --arg registry "${REGISTRY,,}" \
    --arg eventTopic "${event_topic,,}" \
    --arg roundTopic "${round_topic,,}" \
    --arg submitterTopic "${submitter_topic,,}" \
    --arg randomness "${EXPECTED_RANDOMNESS,,}" '
      (.status == "0x1" or .status == 1 or .status == "1")
      and (.logs | length == 1)
      and (
        .logs[0]
        | ((.address | ascii_downcase) == $registry)
          and (
            (.topics | map(ascii_downcase))
            == [$eventTopic, $roundTopic, $submitterTopic]
          )
          and ((.data | ascii_downcase) == $randomness)
      )
    ' <<< "$receipt" > /dev/null; then
    fail "Expected a successful transaction and one matching BeaconStored"
  fi

  assert_equal \
    "$(registry_call "getBeacon(uint64)(bytes32)" "$TARGET")" \
    "$EXPECTED_RANDOMNESS" \
    "Stored randomness"

  printf 'PASS round %s: published randomness stored; matching event\n' \
    "$TARGET"

  check_cached_calls
}

# Check both rounds before sending either transaction.
for round in "$WITNESS_FIRST_ROUND" "$COMPRESSED_FIRST_ROUND"; do
  load_fixture "$round"
  require_unstored
done

# -------------------------------------------------------------------------
# Witness-first submission
# -------------------------------------------------------------------------

load_fixture "$WITNESS_FIRST_ROUND"

INVALID_BEACON_SELECTOR=$(cast sig "InvalidBeacon()")

if REJECTION_OUTPUT=$(
  registry_call "${WITNESS_METHOD}(bytes32)" \
    "$TARGET" "$SIGNATURE" 0 0 \
    2>&1
); then
  fail "Incorrect witness unexpectedly succeeded"
fi

# Match the expected selector using a Bash glob, not a regex.
case "$REJECTION_OUTPUT" in
  *"$INVALID_BEACON_SELECTOR"*)
    printf 'PASS incorrect witness simulation: InvalidBeacon\n'
    ;;
  *)
    fail "Incorrect witness simulation did not report InvalidBeacon"
    ;;
esac

submit_and_check \
  "$WITNESS_METHOD" "$TARGET" "$SIGNATURE" "$Y_HI" "$Y_LO"

# -------------------------------------------------------------------------
# Compressed-first submission
# -------------------------------------------------------------------------

load_fixture "$COMPRESSED_FIRST_ROUND"

submit_and_check \
  "$COMPRESSED_METHOD" "$TARGET" "$SIGNATURE"

printf '\nSmoke test passed.\n'