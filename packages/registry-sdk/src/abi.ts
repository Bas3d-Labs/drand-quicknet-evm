import type {
  Abi,
} from 'viem';

export const drandQuicknetBeaconRegistryAbi = [
  {
    type: 'constructor',
    inputs: [
      {
        name: 'verifier_',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'verifierCodehash_',
        type: 'bytes32',
        internalType: 'bytes32',
      },
      {
        name: 'minimumLeadRounds_',
        type: 'uint64',
        internalType: 'uint64',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'GENESIS_TIMESTAMP',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint64',
        internalType: 'uint64',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'PERIOD_SECONDS',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint64',
        internalType: 'uint64',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getBeacon',
    inputs: [
      {
        name: 'round',
        type: 'uint64',
        internalType: 'uint64',
      },
    ],
    outputs: [
      {
        name: 'randomness',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'isStored',
    inputs: [
      {
        name: 'round',
        type: 'uint64',
        internalType: 'uint64',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'bool',
        internalType: 'bool',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'latestScheduledRound',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint64',
        internalType: 'uint64',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'minimumLeadRounds',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint64',
        internalType: 'uint64',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'roundAt',
    inputs: [
      {
        name: 'timestamp',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'uint64',
        internalType: 'uint64',
      },
    ],
    stateMutability: 'pure',
  },
  {
    type: 'function',
    name: 'roundScheduledTime',
    inputs: [
      {
        name: 'round',
        type: 'uint64',
        internalType: 'uint64',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'pure',
  },
  {
    type: 'function',
    name: 'submitBeacon',
    inputs: [
      {
        name: 'round',
        type: 'uint64',
        internalType: 'uint64',
      },
      {
        name: 'signature',
        type: 'bytes',
        internalType: 'bytes',
      },
    ],
    outputs: [
      {
        name: 'randomness',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'verifier',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'verifierCodehash',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'event',
    name: 'BeaconStored',
    inputs: [
      {
        name: 'round',
        type: 'uint64',
        indexed: true,
        internalType: 'uint64',
      },
      {
        name: 'randomness',
        type: 'bytes32',
        indexed: false,
        internalType: 'bytes32',
      },
      {
        name: 'submitter',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'error',
    name: 'BeaconUnavailable',
    inputs: [
      {
        name: 'round',
        type: 'uint64',
        internalType: 'uint64',
      },
    ],
  },
  {
    type: 'error',
    name: 'InvalidBeacon',
    inputs: [],
  },
  {
    type: 'error',
    name: 'InvalidMinimumLeadRounds',
    inputs: [],
  },
  {
    type: 'error',
    name: 'InvalidRound',
    inputs: [],
  },
  {
    type: 'error',
    name: 'InvalidVerifier',
    inputs: [],
  },
] as const satisfies Abi;