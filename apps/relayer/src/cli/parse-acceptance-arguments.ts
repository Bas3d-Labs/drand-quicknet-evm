import {
  parseRelayerNetworkPreset,
  type NetworkSource,
} from '../config/config.js';

import {
  UsageError,
} from '../diagnostics/usage-error.js';

import {
  isUuidV4,
} from '../shared/uuid.js';

export type AcceptanceCommandArguments = {
  readonly command: 'accept-unattributed';
  readonly source: NetworkSource;
} & (
  | {
      readonly mode: 'apply';
      readonly ticketPath: string;
    }
  | {
      readonly mode: 'dry-run';
      readonly attemptId: string;
      readonly operator: string;
    }
);

export function parseAcceptanceArguments(
  args: readonly string[],
): AcceptanceCommandArguments {
  const values = new Map<string, string>();

  const flags = new Set<string>();

  const valueOptions = [
    '--network',
    '--network-config',
    '--attempt-id',
    '--operator',
    '--ticket',
  ];

  for (let index = 0; index < args.length; index++) {
    const option = args[index]!;

    if (values.has(option) || flags.has(option)) {
      throw new UsageError('INVALID_ACCEPTANCE_ARGUMENTS');
    }

    if (option === '--apply' || option === '--dry-run') {
      flags.add(option);
      continue;
    }

    const value = args[index + 1];

    if (
      !valueOptions.includes(option) ||
      value === undefined ||
      value.length === 0 ||
      value.startsWith('--')
    ) {
      throw new UsageError('INVALID_ACCEPTANCE_ARGUMENTS');
    }

    values.set(option, value);
    index++;
  }

  const preset = values.get('--network');

  const configFile = values.get('--network-config');

  if ((preset === undefined) === (configFile === undefined)) {
    throw new UsageError('INVALID_ACCEPTANCE_ARGUMENTS');
  }

  let source: NetworkSource;

  if (preset !== undefined) {
    source = {
      type: 'preset',
      network: parseRelayerNetworkPreset(preset),
    };
  } else {
    source = {
      type: 'custom',
      configFile: configFile!,
    };
  }

  if (flags.has('--apply')) {
    const ticketPath = values.get('--ticket');

    if (flags.has('--dry-run') || ticketPath === undefined || values.size !== 2) {
      throw new UsageError('INVALID_ACCEPTANCE_ARGUMENTS');
    }

    return {
      command: 'accept-unattributed',
      source,
      mode: 'apply',
      ticketPath,
    };
  }

  const attemptId = values.get('--attempt-id');

  const operator = values.get('--operator');

  if (
    values.has('--ticket') ||
    !isUuidV4(attemptId) ||
    operator === undefined
  ) {
    throw new UsageError('INVALID_ACCEPTANCE_ARGUMENTS');
  }

  return {
    command: 'accept-unattributed',
    source,
    mode: 'dry-run',
    attemptId: attemptId.toLowerCase(),
    operator,
  };
}
