import {
  isFixedHex,
} from '../shared/hex.js';

import type {
  JournalIdentity,
  TransactionJournalRead,
  TransactionJournalSnapshot,
  TransactionJournalStore,
} from './transaction-journal.js';

import {
  verifyJournalSnapshot,
} from './transaction-journal-verification.js';

export interface JournalPersistenceOptions {
  readonly store: TransactionJournalStore;
  readonly identity: JournalIdentity;
  readonly initial: TransactionJournalRead;
}

export type JournalPersistenceState =
  | 'idle'
  | 'writing'
  | 'failed';

/**
 * Coordinator-owned persistence state.
 * 
 * Retains the previous snapshot until a save succeeds. After failure,
 * retains the exact attempted snapshot for a fresh durable retry.
 * 
 * Never reloads storage. Visible contents cannot clear an in-progress
 * persistence-failure latch.
 * 
 * Idle means no persistence operation is outstanding. It does not
 * establish recovery completion or authorize opening the signer gate.
 */
export class JournalPersistence {
  private stateValue: JournalPersistenceState = 'idle';
  private currentValue: TransactionJournalRead;
  private pending: TransactionJournalSnapshot | undefined;

  private constructor(
    private readonly store: TransactionJournalStore,
    private readonly identity: JournalIdentity,
    initial: TransactionJournalRead,
  ) {
    this.currentValue = initial;
  }

  static async create(
    options: JournalPersistenceOptions,
  ): Promise<JournalPersistence> {
    const { chainId, signer } = options.identity;

    if (
      !Number.isSafeInteger(chainId) ||
      chainId <= 0 ||
      !isFixedHex(signer, 20)
    ) {
      throw new TypeError('Invalid journal identity.');
    }

    const identity = Object.freeze({
      chainId,
      signer,
    });

    let initial: TransactionJournalRead;

    switch (options.initial.kind) {
      case 'missing':
        initial = Object.freeze({
          kind: 'missing',
        })
        break;

      case 'present':
        initial = Object.freeze({
          kind: 'present',
          snapshot: await verifyJournalSnapshot(
            options.initial.snapshot,
            identity,
          ),
        });
        break;

      default:
        throw new TypeError('Invalid initial journal state.');
    }

    return new JournalPersistence(options.store, identity, initial);
  }

  get state(): JournalPersistenceState {
    return this.stateValue;
  }

  /**
   * Internal recovery state, including signed bytes.
   */
  get current(): TransactionJournalRead {
    return this.currentValue;
  }

  /**
   * Begins a new write only when no write or failed-write retry
   * is outstanding.
   * 
   * The coordinator must authorize the transition before calling.
   */
  async save(next: TransactionJournalSnapshot): Promise<void> {
    if (this.stateValue !== 'idle') {
      throw new Error('Journal persistence is not ready for a new write.');
    }

    // Mark persistence busy before the first asynchronous boundary.
    this.stateValue = 'writing';

    let snapshot: TransactionJournalSnapshot;

    try {
      snapshot = await verifyJournalSnapshot(next, this.identity);
    } catch {
      this.stateValue = 'idle';
      throw new TypeError('Invalid journal persistence snapshot.');
    }

    this.pending = snapshot;

    await this.persistPending(snapshot);
  }

  /**
   * Retries the exact snapshot retained after a failed save.
   */
  async retry(): Promise<void> {
    if (
      this.stateValue !== 'failed' ||
      this.pending === undefined
    ) {
      throw new Error('No failed journal write is available to retry.');
    }

    const snapshot = this.pending;
    this.stateValue = 'writing';

    await this.persistPending(snapshot);
  }

  private async persistPending(
    snapshot: TransactionJournalSnapshot,
  ): Promise<void> {
    try {
      await this.store.save(snapshot);
    } catch {
      this.stateValue = 'failed';

      throw new Error(
        'Journal persistence did not complete.' +
        'The pending snapshot must be retried.'
      );
    }

    this.currentValue = Object.freeze({
      kind: 'present',
      snapshot,
    });

    this.pending = undefined;
    this.stateValue = 'idle';
  }
}