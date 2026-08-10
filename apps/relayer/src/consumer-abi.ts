export const QUICKNET_RANDOMNESS_REQUESTED_EVENT = {
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
} as const;

export const QUICKNET_RANDOMNESS_CONSUMER_ABI = [
  QUICKNET_RANDOMNESS_REQUESTED_EVENT,
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