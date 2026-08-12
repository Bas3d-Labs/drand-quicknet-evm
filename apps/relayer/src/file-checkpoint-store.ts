import {
  randomUUID,
} from 'node:crypto';
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import {
  dirname,
} from 'node:path';
import {
  getAddress,
  type Address,
} from 'viem';

import type {
  RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

import type {
  CheckpointStore,
} from './checkpoint.js';
import { isDecimalInteger } from './decimal.js';

const CHECKPOINT_FILE_VERSION = 1;

interface CheckpointState {
  consumers: Map<Address, bigint>;
}

interface SerializedConsumerCheckpoint {
  nextBlock: string;
}

interface SerializedCheckpointState {
  version: number;
  chainId: number;
  registry: Address;
  consumers: Record<string, SerializedConsumerCheckpoint>;
}

export interface FileCheckpointStoreOptions {
  filePath: string;
  deployment: RegistryDeployment;
}

export class FileCheckpointStore
  implements CheckpointStore
{
  private readonly filePath: string;
  private readonly chainId: number;
  private readonly registry: Address;

  constructor(
    options: FileCheckpointStoreOptions,
  ) {
    if (options.filePath.length === 0) {
      throw new Error('Checkpoint file path must not be empty.');
    }

    this.filePath = options.filePath;
    this.chainId = options.deployment.chainId;
    this.registry = getAddress(options.deployment.address);
  }

  async load(consumer: Address): Promise<bigint | undefined> {
    const state = await this.readState();
    
    return state.consumers.get(
      getAddress(consumer)
    );
  }

  async save(consumer: Address, nextBlock: bigint): Promise<void> {
    if (nextBlock < 0n) {
      throw new Error('Checkpoint nextBlock must not be negative.');
    }

    const normalizedConsumer = getAddress(consumer);
    const state = await this.readState();

    const current = state.consumers.get(normalizedConsumer);
    if (current !== undefined && nextBlock < current) {
      throw new Error(
        `Checkpoint for consumer ${normalizedConsumer} cannot move backwards from ${current} to ${nextBlock}.`
      );
    }

    state.consumers.set(
      normalizedConsumer,
      nextBlock,
    );

    await this.writeState(state);
  }

  private async readState(): Promise<CheckpointState> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, 'utf8');
    } catch (cause) {
      if (isNodeError(cause) && cause.code === 'ENOENT') {
        return {
          consumers: new Map(),
        }
      }

      throw new Error(
        `Failed to read checkpoint file ${this.filePath}.`,
        { cause }
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (cause) {
      throw new Error(
        `Checkpoint file ${this.filePath} contains invalid JSON.`,
        { cause }
      );
    }

    return this.parseState(parsed);
  }

  private async writeState(state: CheckpointState): Promise<void> {
    const consumers: Record<string, SerializedConsumerCheckpoint> = {};
    for (const [consumer, nextBlock] of state.consumers) {
      consumers[consumer] = {
        nextBlock: nextBlock.toString()
      }
    }

    const serialized: SerializedCheckpointState = {
      version: CHECKPOINT_FILE_VERSION,
      chainId: this.chainId,
      registry: this.registry,
      consumers,
    };

    const contents = `${JSON.stringify(serialized, null, 2)}\n`;
    const directory = dirname(this.filePath);
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;

    try {
      await mkdir(directory, { recursive: true });
      await writeFile(
        tempPath,
        contents,
        {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx',
        }
      );

      await rename(tempPath, this.filePath);
    } catch (cause) {
      try {
        await rm(tempPath, { force: true });
      } catch {
        // Preserve the original write failure.
      }

      throw new Error(
        `Failed to write checkpoint file ${this.filePath}.`,
        { cause }
      );
    }
  }

  private parseState(value: unknown): CheckpointState {
    const root = requireObject(
      value,
      'Checkpoint file root must be an object.'
    );

    if (root.version !== CHECKPOINT_FILE_VERSION) {
      throw new Error(`Unsupported checkpoint file version: ${String(root.version)}.`);
    }

    if (
      typeof root.chainId !== 'number' ||
      !Number.isSafeInteger(root.chainId) ||
      root.chainId <= 0
    ) {
      throw new Error('Checkpoint file contains an invalid chainId.');
    }

    if (root.chainId !== this.chainId) {
      throw new Error(
        `Checkpoint file chainId ${root.chainId} does not match configured chainId ${this.chainId}.`
      );
    }

    if (typeof root.registry !== 'string') {
      throw new Error('Checkpoint file contains an invalid registry address.');
    }

    let registry: Address;
    try {
      registry = getAddress(root.registry);
    } catch (cause) {
      throw new Error(
        'Checkpoint file contains an invalid registry address.',
        { cause }
      );
    }

    if (registry !== this.registry) {
      throw new Error(
        `Checkpoint file registry ${registry} does not match configured registry ${this.registry}.`
      );
    }

    const serializedConsumers = requireObject(
      root.consumers,
      'Checkpoint file consumers must be an object.',
    );

    const consumers = new Map<Address, bigint>();
    for (const [rawConsumer,rawCheckpoint] of Object.entries(serializedConsumers)) {
      let consumer: Address;
      try {
        consumer = getAddress(rawConsumer);
      } catch (cause) {
        throw new Error(
          `Checkpoint file contains an invalid consumer address: ${rawConsumer}.`,
          { cause }
        );
      }

      if (consumers.has(consumer)) {
        throw new Error(`Checkpoint file contains duplicate consumer address ${consumer}.`);
      }

      const checkpoint = requireObject(
        rawCheckpoint, 
        `Checkpoint for consumer ${consumer} must be an object.`
      );

      const nextBlock = parseNextBlock(checkpoint.nextBlock, consumer);

      consumers.set(consumer, nextBlock);
    }

    return { consumers };
  }
}

function parseNextBlock(
  value: unknown,
  consumer: Address,
): bigint {
  if (typeof value !== 'string') {
    throw new Error(`Checkpoint for consumer ${consumer} contains an invalid nextBlock.`);
  }

  if (!isDecimalInteger(value)) {
    throw new Error(`Checkpoint for consumer ${consumer} contains an invalid nextBlock.`);
  }

  return BigInt(value);
}

function requireObject(
  value: unknown,
  message: string,
): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error(message);
  }

  return value as Record<string, unknown>;
}

function isNodeError(
  value: unknown,
): value is NodeJS.ErrnoException {
  return (value instanceof Error && 'code' in value);
}