import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  SignerAuthorization,
} from '../../src/state/signer-authorization.js';

interface AuthorizationState {
  readonly recoveryComplete: boolean;
  readonly inclusionChecksComplete: boolean;
  readonly broadcastPermit: string | undefined;
}

interface TransitionCase {
  readonly name: string;
  readonly apply: (authorization: SignerAuthorization) => void;
  readonly changes: Partial<AuthorizationState>;
  readonly allowsGrant?: boolean;
  readonly clearsAll?: boolean;
}

const FIRST_ATTEMPT = 'first-attempt';
const SECOND_ATTEMPT = 'second-attempt';
const NEXT_ATTEMPT = 'next-attempt';

const CLEAR_ACTION = {
  inclusionChecksComplete: false,
  broadcastPermit: undefined,
};

const CLEAR_ALL = {
  recoveryComplete: false,
  inclusionChecksComplete: false,
  broadcastPermit: undefined,
};

const TRANSITIONS: readonly TransitionCase[] = [
  {
    name: 'acknowledged completion failed',
    apply: (authorization) => authorization.completionFailed(),
    changes: CLEAR_ALL,
    clearsAll: true,
  },
  {
    name: 'inspection begun',
    apply: (authorization) => authorization.inspectionBegun(),
    changes: CLEAR_ACTION,
  },
  {
    name: 'inclusion check entered',
    apply: (authorization) => authorization.inclusionCheckEntered(),
    changes: CLEAR_ACTION,
  },
  {
    name: 'existing bracket failed',
    apply: (authorization) => authorization.bracketFailed(),
    changes: CLEAR_ACTION,
  },
  {
    name: 'abandonment requested',
    apply: (authorization) => authorization.abandonmentRequested(),
    changes: CLEAR_ACTION,
  },
  {
    name: 'abandonment completed',
    apply: (authorization) => authorization.abandonmentCompleted(),
    changes: CLEAR_ACTION,
  },
  {
    name: 'recovery started',
    apply: (authorization) => authorization.recoveryStarted(),
    changes: CLEAR_ALL,
    clearsAll: true,
  },
  {
    name: 'broadcast started',
    apply: (authorization) => authorization.broadcastStarted(),
    changes: CLEAR_ALL,
    clearsAll: true,
  },
  {
    name: 'stored-fact conflict before signing',
    apply: (authorization) => authorization.storedFactConflictBeforeSigning(),
    changes: CLEAR_ALL,
    clearsAll: true,
  },
  {
    name: 'preparation reached storage without completion',
    apply: (authorization) =>
      authorization.preparationReachedStorageWithoutCompletion(),
    changes: CLEAR_ALL,
    clearsAll: true,
  },
  {
    name: 'terminal correction committed',
    apply: (authorization) => authorization.terminalCorrectionCommitted(),
    changes: CLEAR_ALL,
    clearsAll: true,
  },
  {
    name: 'evidence contradicted',
    apply: (authorization) => authorization.evidenceContradicted(),
    changes: { recoveryComplete: false },
  },
  {
    name: 'recovery failed',
    apply: (authorization) => authorization.recoveryFailed(),
    changes: { recoveryComplete: false },
  },
  {
    name: 'inclusion check failed',
    apply: (authorization) => authorization.inclusionCheckFailed(),
    changes: { inclusionChecksComplete: false },
  },
  {
    name: 'preparation started',
    apply: (authorization) => authorization.preparationStarted(),
    changes: { broadcastPermit: undefined },
  },
  {
    name: 'preparation about to save',
    apply: (authorization) => authorization.preparationAboutToSave(),
    changes: { inclusionChecksComplete: false },
  },
  {
    name: 'preparation rolled back to incomplete inclusion checks',
    apply: (authorization) => authorization.preparationRolledBack(false),
    changes: { inclusionChecksComplete: false },
  },
  {
    name: 'preparation rolled back to complete inclusion checks',
    apply: (authorization) => authorization.preparationRolledBack(true),
    changes: { inclusionChecksComplete: true },
    allowsGrant: true,
  },
  {
    name: 'ordinary recovery committed',
    apply: (authorization) => authorization.recoveryCommitted(false),
    changes: { recoveryComplete: true },
    allowsGrant: true,
  },
  {
    name: 'terminal recovery committed before completion',
    apply: (authorization) => authorization.recoveryCommitted(true),
    changes: { recoveryComplete: false },
  },
  {
    name: 'bootstrap committed',
    apply: (authorization) => authorization.bootstrapCommitted(),
    changes: { recoveryComplete: true },
    allowsGrant: true,
  },
  {
    name: 'incomplete inclusion check committed',
    apply: (authorization) => authorization.inclusionCheckCommitted(false),
    changes: { inclusionChecksComplete: false },
  },
  {
    name: 'complete inclusion check committed',
    apply: (authorization) => authorization.inclusionCheckCommitted(true),
    changes: { inclusionChecksComplete: true },
    allowsGrant: true,
  },
  {
    name: 'preparation permit granted',
    apply: (authorization) =>
      authorization.grantPreparationPermit(NEXT_ATTEMPT),
    changes: { broadcastPermit: NEXT_ATTEMPT },
    allowsGrant: true,
  },
  {
    name: 'recovery permit granted',
    apply: (authorization) => authorization.grantRecoveryPermit(NEXT_ATTEMPT),
    changes: { broadcastPermit: NEXT_ATTEMPT },
    allowsGrant: true,
  },
  {
    name: 'inclusion permit granted',
    apply: (authorization) => authorization.grantInclusionPermit(NEXT_ATTEMPT),
    changes: { broadcastPermit: NEXT_ATTEMPT },
    allowsGrant: true,
  },
];

function read(authorization: SignerAuthorization): AuthorizationState {
  return {
    recoveryComplete: authorization.recoveryComplete,
    inclusionChecksComplete: authorization.inclusionChecksComplete,
    broadcastPermit: authorization.broadcastPermit,
  };
}

function seed(state: AuthorizationState): SignerAuthorization {
  const authorization = new SignerAuthorization();

  authorization.recoveryCommitted(!state.recoveryComplete);
  authorization.inclusionCheckCommitted(state.inclusionChecksComplete);

  if (state.broadcastPermit !== undefined) {
    authorization.grantRecoveryPermit(state.broadcastPermit);
  }

  expect(read(authorization)).toEqual(state);

  return authorization;
}

function states(): AuthorizationState[] {
  const combinations: AuthorizationState[] = [];

  for (const recoveryComplete of [false, true]) {
    for (const inclusionChecksComplete of [false, true]) {
      for (const broadcastPermit of [
        undefined,
        FIRST_ATTEMPT,
        SECOND_ATTEMPT
      ]) {
        combinations.push({
          recoveryComplete,
          inclusionChecksComplete,
          broadcastPermit,
        });
      }
    }
  }

  return combinations;
}

describe('signer authorization transitions', () => {
  it('starts with both completion flags false and no broadcast permit', () => {
    expect(read(new SignerAuthorization())).toEqual(CLEAR_ALL);
  });

  it.each(TRANSITIONS)(
    '$name changes only its specified fields',
    (transition) => {
      const before = {
        recoveryComplete: true,
        inclusionChecksComplete: true,
        broadcastPermit: FIRST_ATTEMPT,
      };
      const authorization = seed(before);

      transition.apply(authorization);

      expect(read(authorization)).toEqual({
        ...before,
        ...transition.changes,
      });
    }
  );

  it.each(states())(
    'walks every transition from recovery=$recoveryComplete, inclusion=$inclusionChecksComplete, permit=$broadcastPermit',
    (before) => {
      for (const transition of TRANSITIONS) {
        const authorization = seed(before);

        transition.apply(authorization);

        const after = read(authorization);

        expect(after, transition.name).toEqual({
          ...before,
          ...transition.changes,
        });

        if (!transition.allowsGrant) {
          if (!before.recoveryComplete) {
            expect(after.recoveryComplete, transition.name).toBe(false);
          }

          if (!before.inclusionChecksComplete) {
            expect(after.inclusionChecksComplete, transition.name).toBe(false);
          }

          if (after.broadcastPermit !== undefined) {
            expect(after.broadcastPermit, transition.name)
              .toBe(before.broadcastPermit);
          }
        }

        if (transition.clearsAll) {
          expect(after, transition.name).toEqual(CLEAR_ALL);
        }
      }
    },
  );
});
