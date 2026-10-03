import {
  readFile,
} from 'node:fs/promises';

import {
  resolve,
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
import { isDecimalInteger } from '../shared/decimal.js';

import {
  durableReplace,
} from './durable-replace.js';

import {
  removeCheckpointTempFiles,
} from './checkpoint-temp-files.js';

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

  private state: CheckpointState | undefined;
  private operations: Promise<void> = Promise.resolve();

  private constructor(
    options: FileCheckpointStoreOptions,
  ) {
    if (options.filePath.length === 0) {
      throw new Error('Checkpoint file path must not be empty.');
    }

    this.filePath = resolve(options.filePath);
    this.chainId = options.deployment.chainId;
    this.registry = getAddress(options.deployment.address);
  }

  /**
   * Opens and prepares a checkpoint store before returning it.
   * 
   * Requires exclusive service ownership and an existing, trusted state
   * directory. Opening validates existing state, removes orphaned
   * temporary files, and durably writes the initial snapshot.
   */
  static async open(
    options: FileCheckpointStoreOptions,
  ): Promise<FileCheckpointStore> {
    const store = new FileCheckpointStore(options);

    await store.initializeState();

    return store;
  }

  async load(consumer: Address): Promise<bigint | undefined> {
    const normalizedConsumer = getAddress(consumer);

    return this.exclusive(async () => {
      const state = await this.initializeState();
      return state.consumers.get(normalizedConsumer);
    });
  }

  async save(consumer: Address, nextBlock: bigint): Promise<void> {
    if (nextBlock < 0n) {
      throw new Error('Checkpoint nextBlock must not be negative.');
    }

    const normalizedConsumer = getAddress(consumer);

    await this.exclusive(async () => {
      const state = await this.initializeState();
      const current = state.consumers.get(normalizedConsumer);

      if (current !== undefined && nextBlock < current) {
        throw new Error(
        `Checkpoint for consumer ${normalizedConsumer} ` +
        `cannot move backwards from ${current} to ${nextBlock}.`
        )
      }

      // Do not mutate the last known durable snapshot.
      const next: CheckpointState = {
        consumers: new Map(state.consumers),
      };

      next.consumers.set(normalizedConsumer, nextBlock);

      try {
        await this.writeState(next);
      } catch (error) {
        // Replacement may have occurred before durability failed. Reload
        // and durably rewrite the disk snapshot on next access.
        this.state = undefined;
        throw error;
      }

      // Publish only after file and directory synchorization succeed.
      this.state = next;
    });
  }

  private async initializeState(): Promise<CheckpointState> {
    if (this.state !== undefined) {
      return this.state;
    }

    const state = await this.readState();

    await removeCheckpointTempFiles(this.filePath);

    // A previous process may have exited after rename but before
    // directory synchronization. Rewrite the validated snapshot through
    // a fresh file before considering it durable in this process.
    //
    // If no checkpoint exists, this creates a durable empty snapshot.
    await this.writeState(state);

    this.state = state;

    return state;
  }

  private exclusive<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const pending = this.operations.then(operation);

    // A rejected operation must not prevent a later complete rewrite.
    this.operations = pending.then(
      () => undefined,
      () => undefined,
    );

    return pending;
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

  private async writeState(
    state: CheckpointState,
  ): Promise<void> {
    const consumers: Record<string, SerializedConsumerCheckpoint> = {};

    for (const [consumer, nextBlock] of state.consumers) {
      consumers[consumer] = {
        nextBlock: nextBlock.toString(),
      };
    }

    const serialized: SerializedCheckpointState = {
      version: CHECKPOINT_FILE_VERSION,
      chainId: this.chainId,
      registry: this.registry,
      consumers,
    };

    const contents = `${JSON.stringify(serialized, null, 2)}\n`;

    await durableReplace(this.filePath, contents);
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