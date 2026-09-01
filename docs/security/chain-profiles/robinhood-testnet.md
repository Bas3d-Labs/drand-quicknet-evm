---
profileVersion: 1

network: robinhood-testnet
chainId: 46630
onboardingTier: 2

randomness:
  beacon: drand-quicknet
  periodSeconds: 3

timing:
  minimumLeadRounds: 5
  timestampFreshnessReserveSeconds: 3

securityModel:
  timestampAuthority: sequencer
  historyIntegrityAssumption: trusted-sequencer
  assumptionsSection: security-assumptions

monitoring:
  timestampSkewSeconds:
    warning: 5
    critical: 8

chainAdapter:
  type: arbitrum-nitro
  config:
    parentChain:
      name: ethereum-sepolia
      chainId: 11155111
      slotSeconds: 12
      requireTimeVariationSlotParity: true

    rollup: '0xdc5F8E399DBd8a9F5F87AeC4C23Beb12431b386D'
    expectedSequencerInbox: '0xA0D9dB3DC9791D54b5183C1C1866eFe1eCA7D414'

    expectedMaxTimeVariation:
      delayBlocks: 28800
      futureBlocks: 300
      delaySeconds: 345600
      futureSeconds: 3600

    approvedWasmModuleRoots:
      - consensusRelease: consensus-v61
        root: '0xc10cd7ec6acaf1c441a3f6bd0900ad20f15855ba775a96f1939118cbc629dc97'

deploymentManifest: '../../../deployments/robinhood-testnet.json'
---