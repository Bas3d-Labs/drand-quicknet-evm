import {
  type Address,
  type Hex,
} from 'viem';

import {
  assertOnlyKeys,
  requireAddress,
  requireBoolean,
  requireBytes32,
  requireNonNegativeInteger,
  requirePositiveInteger,
  requireRecord,
  requireString,
} from '../../core/validation.js';

export interface MaxTimeVariation {
  delayBlocks: number;
  futureBlocks: number;
  delaySeconds: number;
  futureSeconds: number;
}

export interface ApprovedWasmModuleRoot {
  consensusRelease: string;
  root: Hex;
}

export interface ArbitrumNitroConfig {
  parentChain: {
    name: string;
    chainId: number;
    slotSeconds: number;
    requireTimeVariationSlotParity: boolean;
  };

  rollup: Address;
  expectedSequencerInbox: Address;
  expectedMaxTimeVariation: MaxTimeVariation;
  approvedWasmModuleRoots: ApprovedWasmModuleRoot[];
}

function validateMaxTimeVariation(
  value: unknown,
): MaxTimeVariation {
  const path = 'chainAdapter.config.expectedMaxTimeVariation';

  const variation = requireRecord(value, path);

  assertOnlyKeys(
    variation,
    [
      'delayBlocks',
      'futureBlocks',
      'delaySeconds',
      'futureSeconds',
    ],
    path,
  );

  return {
    delayBlocks: requireNonNegativeInteger(
      variation.delayBlocks,
      `${path}.delayBlocks`,
    ),
    futureBlocks: requireNonNegativeInteger(
      variation.futureBlocks,
      `${path}.futureBlocks`,
    ),
    delaySeconds: requireNonNegativeInteger(
      variation.delaySeconds,
      `${path}.delaySeconds`,
    ),
    futureSeconds: requireNonNegativeInteger(
      variation.futureSeconds,
      `${path}.futureSeconds`,
    ),
  };
}

function validateApprovedWasmModuleRoots(
  value: unknown,
): ApprovedWasmModuleRoot[] {
  const path = 'chainAdapter.config.approvedWasmModuleRoots';
  if (
    !Array.isArray(value) ||
    value.length === 0
  ) {
    throw new Error(`${path} must be a non-empty array.`);
  }

  const roots = new Set<string>();
  const releases = new Set<string>();
  const validated: ApprovedWasmModuleRoot[] = [];

  for (const [index, item] of value.entries()) {
    const itemPath = `${path}[${index}]`;
    const entry = requireRecord(item, itemPath);

    assertOnlyKeys(
      entry,
      [
        'consensusRelease',
        'root',
      ],
      itemPath,
    );

    const consensusRelease = requireString(
      entry.consensusRelease,
      `${itemPath}.consensusRelease`,
    );

    const root = requireBytes32(
      entry.root,
      `${itemPath}.root`,
    );

    if (releases.has(consensusRelease)) {
      throw new Error(
        `duplicate approved consensus release: ${consensusRelease}`,
      );
    }

    if (roots.has(root)) {
      throw new Error(
        `duplicate approved WASM root: ${root}`,
      );
    }

    releases.add(consensusRelease);
    roots.add(root);

    validated.push({
      consensusRelease,
      root,
    });
  }

  return validated;
}

function validateSlotParity(
  config: ArbitrumNitroConfig,
): void {
  if (!config.parentChain.requireTimeVariationSlotParity) {
    return;
  }

  const slotSeconds = BigInt(
    config.parentChain.slotSeconds,
  );

  const variation = config.expectedMaxTimeVariation;

  const expectedDelaySeconds =
    BigInt(variation.delayBlocks) * slotSeconds;

  const expectedFutureSeconds =
    BigInt(variation.futureBlocks) * slotSeconds;

  if (
    expectedDelaySeconds !== BigInt(variation.delaySeconds)
  ) {
    throw new Error(
      'delayBlocks/delaySeconds do not match '
      + 'parent-chain slot parity: '
      + `${variation.delayBlocks} * `
      + `${config.parentChain.slotSeconds} != `
      + `${variation.delaySeconds}`,
    );
  }

  if (
    expectedFutureSeconds !== BigInt(variation.futureSeconds)
  ) {
    throw new Error(
      'futureBlocks/futureSeconds do not match '
      + 'parent-chain slot parity: '
      + `${variation.futureBlocks} * `
      + `${config.parentChain.slotSeconds} != `
      + `${variation.futureSeconds}`,
    );
  }
}

export function validateArbitrumNitroConfig(
  value: unknown,
): ArbitrumNitroConfig {
  const path = 'chainAdapter.config';
  const config = requireRecord(value, path);

  assertOnlyKeys(
    config,
    [
      'parentChain',
      'rollup',
      'expectedSequencerInbox',
      'expectedMaxTimeVariation',
      'approvedWasmModuleRoots',
    ],
    path,
  );

  const parentChain = requireRecord(
    config.parentChain,
    `${path}.parentChain`,
  );

  assertOnlyKeys(
    parentChain,
    [
      'name',
      'chainId',
      'slotSeconds',
      'requireTimeVariationSlotParity',
    ],
    `${path}.parentChain`,
  );

  const validated: ArbitrumNitroConfig = {
    parentChain: {
      name: requireString(
        parentChain.name,
        `${path}.parentChain.name`,
      ),
      chainId: requirePositiveInteger(
        parentChain.chainId,
        `${path}.parentChain.chainId`,
      ),
      slotSeconds: requirePositiveInteger(
        parentChain.slotSeconds,
        `${path}.parentChain.slotSeconds`,
      ),
      requireTimeVariationSlotParity:
        requireBoolean(
          parentChain.requireTimeVariationSlotParity,
          `${path}.parentChain.requireTimeVariationSlotParity`,
        ),
    },

    rollup: requireAddress(
      config.rollup,
      `${path}.rollup`,
    ),

    expectedSequencerInbox: requireAddress(
      config.expectedSequencerInbox,
      `${path}.expectedSequencerInbox`,
    ),

    expectedMaxTimeVariation:
      validateMaxTimeVariation(
        config.expectedMaxTimeVariation,
      ),

    approvedWasmModuleRoots:
      validateApprovedWasmModuleRoots(
        config.approvedWasmModuleRoots,
      ),
  };

  validateSlotParity(validated);

  return validated;
}