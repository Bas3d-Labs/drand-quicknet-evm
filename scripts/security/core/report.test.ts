import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  createVerificationReport,
  serializeVerificationReport,
  type CreateVerificationReportInput,
  type VerificationCheck,
} from './report.js';

const NETWORK = 'test-network';
const CHAIN_ID = 12345;
const PARENT_CHAIN_ID = 54321;

const VERIFICATION_TIME = new Date('2026-09-02T12:34:56Z');

const REPOSITORY_REVISION = 'abc123';

function createInput(): CreateVerificationReportInput {
  return {
    network: NETWORK,
    chainId: CHAIN_ID,
    verificationTime: VERIFICATION_TIME,
    repositoryRevision: REPOSITORY_REVISION,
    repositoryDirty: false,
    observations: [
      {
        id: 'chain',
        chainId: CHAIN_ID,
        blockNumber: 123456n,
        blockTimestamp: 1700000000n,
      },
    ],
    checks: [
      {
        id: 'example.check',
        observationIds: [
          'chain',
        ],
        status: 'MATCH',
        expected: 5n,
        observed: 5n,
      },
    ],
  };
}

describe('createVerificationReport', () => {
  it('creates a MATCH report', () => {
    const report = createVerificationReport(
      createInput(),
    );

    expect(report).toEqual({
      reportVersion: 1,
      network: NETWORK,
      chainId: CHAIN_ID,
      verificationTimestamp: '2026-09-02T12:34:56.000Z',
      repositoryRevision: REPOSITORY_REVISION,
      repositoryDirty: false,
      observations: [
        {
          id: 'chain',
          chainId: CHAIN_ID,
          blockNumber: 123456n,
          blockTimestamp: 1700000000n,
        },
      ],
      checks: [
        {
          id: 'example.check',
          observationIds: [
            'chain',
          ],
          status: 'MATCH',
          expected: 5n,
          observed: 5n,
        },
      ],
      aggregateStatus: 'MATCH',
    });
  });

  it('derives DRIFT from the checks', () => {
    const input = createInput();

    input.checks = [
      {
        id: 'matching.check',
        observationIds: [
          'chain',
        ],
        status: 'MATCH',
        expected: 5n,
        observed: 5n,
      },
      {
        id: 'drifting.check',
        observationIds: [
          'chain',
        ],
        status: 'DRIFT',
        expected: 5n,
        observed: 6n,
        reason: 'Observed value changed.',
      },
    ];

    const report = createVerificationReport(input);

    expect(report.aggregateStatus).toBe(
      'DRIFT',
    );
  });

  it('lets ERROR dominate DRIFT', () => {
    const input = createInput();

    input.checks = [
      {
        id: 'drifting.check',
        observationIds: [
          'chain',
        ],
        status: 'DRIFT',
        expected: 5n,
        observed: 6n,
        reason: 'Observed value changed.',
      },
      {
        id: 'error.check',
        observationIds: [
          'chain',
        ],
        status: 'ERROR',
        expected: 5n,
        error: 'RPC failed.',
      },
    ];

    const report = createVerificationReport(input);

    expect(report.aggregateStatus).toBe(
      'ERROR',
    );
  });

  it('treats a standalone skipped result as ERROR', () => {
    const input = createInput();

    input.checks = [
      {
        id: 'matching.check',
        observationIds: [
          'chain',
        ],
        status: 'MATCH',
        expected: 5n,
        observed: 5n,
      },
      {
        id: 'skipped.check',
        observationIds: [
          'chain',
        ],
        status: 'SKIPPED',
        expected: 5n,
        reason: 'Prerequisite unavailable.',
      },
    ];

    const report = createVerificationReport(input);

    expect(report.aggregateStatus).toBe(
      'ERROR',
    );
  });

  it('treats an empty check set as ERROR', () => {
    const input = createInput();

    input.checks = [];

    const report =
      createVerificationReport(input);

    expect(report.aggregateStatus).toBe(
      'ERROR',
    );
  });

  it('allows a check without a chain observation', () => {
    const input = createInput();

    input.checks = [
      {
        id: 'local.check',
        observationIds: [],
        status: 'MATCH',
        expected: 'expected',
        observed: 'expected',
      },
    ];

    const report = createVerificationReport(input);

    expect(report.aggregateStatus).toBe(
      'MATCH',
    );

    expect(
      report.checks[0]?.observationIds,
    ).toEqual([]);
  });

  it('allows a check to reference multiple observations', () => {
    const input = createInput();

    input.observations = [
      {
        id: 'chain',
        chainId: CHAIN_ID,
        blockNumber: 123456n,
        blockTimestamp: 1700000000n,
      },
      {
        id: 'parent',
        chainId: PARENT_CHAIN_ID,
        blockNumber: 654321n,
        blockTimestamp: 1700000001n,
      },
    ];

    input.checks = [
      {
        id: 'cross-chain.check',
        observationIds: [
          'chain',
          'parent',
        ],
        status: 'MATCH',
        expected: true,
        observed: true,
      },
    ];

    const report = createVerificationReport(input);

    expect(
      report.checks[0]?.observationIds,
    ).toEqual([
      'chain',
      'parent',
    ]);
  });

  it('rejects an empty network', () => {
    const input = createInput();

    input.network = '   ';

    expect(
      () => createVerificationReport(input),
    ).toThrow(
      'network must not be empty.'
    );
  });

  it('rejects an invalid chain ID', () => {
    const input = createInput();

    input.chainId = 0;

    expect(
      () => createVerificationReport(input),
    ).toThrow(
      'chainId must be a positive safe integer.'
    );
  });

  it('rejects an empty repository revision', () => {
    const input = createInput();

    input.repositoryRevision = '';

    expect(
      () => createVerificationReport(input),
    ).toThrow(
      'repositoryRevision must not be empty.'
    );
  });

  it('rejects an invalid verification time', () => {
    const input = createInput();

    input.verificationTime = new Date(Number.NaN);

    expect(
      () => createVerificationReport(input),
    ).toThrow(
      'verificationTime must be a valid date.'
    );
  });

  it('rejects duplicate observation IDs', () => {
    const input = createInput();

    input.observations = [
      {
        id: 'chain',
        chainId: CHAIN_ID,
        blockNumber: 123456n,
        blockTimestamp: 1700000000n,
      },
      {
        id: 'chain',
        chainId: PARENT_CHAIN_ID,
        blockNumber: 654321n,
        blockTimestamp: 1700000001n,
      },
    ];

    expect(
      () => createVerificationReport(input),
    ).toThrow(
      'duplicate observation ID: chain.'
    );
  });

  it('rejects a negative block number', () => {
    const input = createInput();

    input.observations = [
      {
        id: 'chain',
        chainId: CHAIN_ID,
        blockNumber: -1n,
        blockTimestamp: 1700000000n,
      },
    ];

    expect(
      () => createVerificationReport(input),
    ).toThrow(
      'observations[0].blockNumber must be non-negative.'
    );
  });

  it('rejects a negative block timestamp', () => {
    const input = createInput();

    input.observations = [
      {
        id: 'chain',
        chainId: CHAIN_ID,
        blockNumber: 123456n,
        blockTimestamp: -1n,
      },
    ];

    expect(
      () => createVerificationReport(input),
    ).toThrow(
      'observations[0].blockTimestamp must be non-negative.'
    );
  });

  it('rejects duplicate check IDs', () => {
    const input = createInput();

    input.checks = [
      {
        id: 'example.check',
        observationIds: [
          'chain',
        ],
        status: 'MATCH',
        expected: 5n,
        observed: 5n,
      },
      {
        id: 'example.check',
        observationIds: [
          'chain',
        ],
        status: 'MATCH',
        expected: 6n,
        observed: 6n,
      },
    ];

    expect(
      () => createVerificationReport(input),
    ).toThrow(
      'duplicate check ID: example.check.'
    );
  });

  it('rejects an unknown observation reference', () => {
    const input = createInput();

    input.checks = [
      {
        id: 'example.check',
        observationIds: [
          'unknown',
        ],
        status: 'MATCH',
        expected: 5n,
        observed: 5n,
      },
    ];

    expect(
      () => createVerificationReport(input),
    ).toThrow(
      'checks[0] references unknown observation ID: unknown.'
    );
  });

  it('rejects duplicate observation references', () => {
    const input = createInput();

    input.checks = [
      {
        id: 'example.check',
        observationIds: [
          'chain',
          'chain',
        ],
        status: 'MATCH',
        expected: 5n,
        observed: 5n,
      },
    ];

    expect(
      () => createVerificationReport(input),
    ).toThrow(
      'checks[0] contains duplicate observation ID: chain.'
    );
  });

  it('rejects an empty observation reference', () => {
    const input = createInput();

    input.checks = [
      {
        id: 'example.check',
        observationIds: [
          '',
        ],
        status: 'MATCH',
        expected: 5n,
        observed: 5n,
      },
    ];

    expect(
      () => createVerificationReport(input),
    ).toThrow(
      'checks[0].observationIds[0] must not be empty.'
    );
  });

  it('rejects an empty DRIFT reason', () => {
    const input = createInput();

    input.checks = [
      {
        id: 'example.check',
        observationIds: [
          'chain',
        ],
        status: 'DRIFT',
        expected: 5n,
        observed: 6n,
        reason: ' ',
      },
    ];

    expect(
      () => createVerificationReport(input),
    ).toThrow(
      'checks[0].reason must not be empty.'
    );
  });

  it('rejects an empty SKIPPED reason', () => {
    const input = createInput();

    input.checks = [
      {
        id: 'example.check',
        observationIds: [
          'chain',
        ],
        status: 'SKIPPED',
        expected: 5n,
        reason: '',
      },
    ];

    expect(
      () => createVerificationReport(input),
    ).toThrow(
      'checks[0].reason must not be empty.'
    );
  });

  it('rejects an empty ERROR message', () => {
    const input = createInput();

    input.checks = [
      {
        id: 'example.check',
        observationIds: [
          'chain',
        ],
        status: 'ERROR',
        expected: 5n,
        error: ' ',
      },
    ];

    expect(
      () => createVerificationReport(input),
    ).toThrow(
      'checks[0].error must not be empty.'
    );
  });

  it('rejects non-finite report values', () => {
    const input = createInput();

    input.checks = [
      {
        id: 'example.check',
        observationIds: [
          'chain',
        ],
        status: 'MATCH',
        expected: {
          nested: {
            value: Number.POSITIVE_INFINITY,
          },
        },
        observed: 5,
      },
    ];

    expect(
      () => createVerificationReport(input),
    ).toThrow(
      'checks[0].expected.nested.value must contain only finite numbers.'
    );
  });

  it('rejects unsafe integer report values', () => {
    const input = createInput();

    input.checks = [
      {
        id: 'example.check',
        observationIds: [
          'chain',
        ],
        status: 'MATCH',
        expected:
          Number.MAX_SAFE_INTEGER + 1,
        observed: 5,
      },
    ];

    expect(
      () => createVerificationReport(input),
    ).toThrow(
      'checks[0].expected must contain only safe integer numbers.'
    );
  });
  
  it('rejects an empty observation ID', () => {
    const input = createInput();

    input.observations = [
      {
        id: ' ',
        chainId: CHAIN_ID,
        blockNumber: 123456n,
        blockTimestamp: 1700000000n,
      },
    ];

    expect(
      () => createVerificationReport(input),
    ).toThrow(
      'observations[0].id must not be empty.'
    );
  });

  it('rejects an invalid observation chain ID', () => {
    const input = createInput();

    input.observations = [
      {
        id: 'chain',
        chainId: 0,
        blockNumber: 123456n,
        blockTimestamp: 1700000000n,
      },
    ];

    expect(
      () => createVerificationReport(input),
    ).toThrow(
      'observations[0].chainId must be a positive safe integer.'
    );
  });

  it('rejects an empty check ID', () => {
    const input = createInput();

    input.checks = [
      {
        id: ' ',
        observationIds: [
          'chain',
        ],
        status: 'MATCH',
        expected: 5n,
        observed: 5n,
      },
    ];

    expect(
      () => createVerificationReport(input),
    ).toThrow(
      'checks[0].id must not be empty.'
    );
  });

  it('clones report inputs', () => {
    const expected = {
      nested: {
        value: 5n,
      },
    };

    const details = {
      release: 'release-1',
    };

    const observationIds = [
      'chain',
    ];

    const check: VerificationCheck = {
      id: 'example.check',
      observationIds,
      status: 'MATCH',
      expected,
      observed: 5n,
      details,
    };

    const observation = {
      id: 'chain',
      chainId: CHAIN_ID,
      blockNumber: 123456n,
      blockTimestamp: 1700000000n,
    };

    const input: CreateVerificationReportInput = {
      network: NETWORK,
      chainId: CHAIN_ID,
      verificationTime: VERIFICATION_TIME,
      repositoryRevision: REPOSITORY_REVISION,
      repositoryDirty: false,
      observations: [
        observation,
      ],
      checks: [
        check,
      ],
    };

    const report = createVerificationReport(input);

    expected.nested.value = 6n;
    details.release = 'release-2';
    observationIds.push('other');
    observation.blockNumber = 999999n;

    expect(report.observations[0]).toEqual({
      id: 'chain',
      chainId: CHAIN_ID,
      blockNumber: 123456n,
      blockTimestamp: 1700000000n,
    });

    expect(report.checks[0]).toEqual({
      id: 'example.check',
      observationIds: [
        'chain',
      ],
      status: 'MATCH',
      expected: {
        nested: {
          value: 5n,
        },
      },
      observed: 5n,
      details: {
        release: 'release-1',
      },
    });
  });
});

describe('serializeVerificationReport', () => {
  it('serializes bigint values as decimal strings', () => {
    const input = createInput();

    input.checks = [
      {
        id: 'example.check',
        observationIds: [
          'chain',
        ],
        status: 'MATCH',
        expected: {
          leadRounds: 5n,
          nested: [
            10n,
            {
              round: 123456789n,
            },
          ],
        },
        observed: {
          leadRounds: 5n,
        },
      },
    ];

    const report = createVerificationReport(input);

    const serialized = serializeVerificationReport(report);

    const parsed = JSON.parse(
      serialized,
    ) as {
      observations: Array<{
        id: string;
        chainId: number;
        blockNumber: string;
        blockTimestamp: string;
      }>;
      checks: Array<{
        expected: {
          leadRounds: string;
          nested: Array<
            string |
            {
              round: string;
            }
          >;
        };
        observed: {
          leadRounds: string;
        };
      }>;
    };

    expect(parsed.observations[0]).toEqual({
      id: 'chain',
      chainId: CHAIN_ID,
      blockNumber: '123456',
      blockTimestamp: '1700000000',
    });

    expect(parsed.checks[0]?.expected).toEqual({
      leadRounds: '5',
      nested: [
        '10',
        {
          round: '123456789',
        },
      ],
    });

    expect(parsed.checks[0]?.observed).toEqual({
      leadRounds: '5',
    });
  });

  it('ends serialized reports with a newline', () => {
    const report = createVerificationReport(
      createInput(),
    );

    const serialized = serializeVerificationReport(report);

    expect(
      serialized.endsWith('\n'),
    ).toBe(true);
  });
});