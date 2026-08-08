import { 
  QUICKNET_GENESIS_TIMESTAMP, 
  QUICKNET_PERIOD_SECONDS 
} from "./constants.js";

export function roundAt(timestamp: bigint) {
  if (timestamp < QUICKNET_GENESIS_TIMESTAMP) {
    return 0n;
  }

  return (
    (timestamp - QUICKNET_GENESIS_TIMESTAMP) / QUICKNET_PERIOD_SECONDS + 1n
  );  
}

export function roundScheduledTime(round: bigint): bigint {
  if (round === 0n) {
    throw new RangeError("Quicknet round must be greater than zero.");
  }

  return (
    QUICKNET_GENESIS_TIMESTAMP + (round - 1n) * QUICKNET_PERIOD_SECONDS
  );
}