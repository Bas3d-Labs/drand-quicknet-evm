export const RELAYER_NETWORK_PRESETS = [
  'robinhood-testnet',
] as const;

export type RelayerNetworkPreset =
  (typeof RELAYER_NETWORK_PRESETS)[number];