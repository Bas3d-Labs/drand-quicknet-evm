export const QUICKNET_RANDOMNESS_CONSUMER_ABI = [
  {
    type: 'event',
    name: 'QuicknetRandomnessRequested',
    inputs: [
      {
        name: 'round',
        type: 'uint64',
        indexed: true,
      },
    ],
    anonymous: false,
  },
  {
    type: 'function',
    name: 'quicknetBeaconRegistry',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
      },
    ],
  },
] as const;