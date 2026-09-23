import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

class CheckError extends Error {}

function check(condition, message) {
  if (!condition) {
    throw new CheckError(message);
  }
}

const rpcUrl = process.env.QUICKNET_RPC_URL;

const p = BigInt(
  '0x1a0111ea397fe69a4b1ba7b6434bacd7' +
  '64774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab',
);

const pairingAddress = '0x000000000000000000000000000000000000000f';
const verifyMethod = 'verifyBeacon(uint64,bytes)';
const witnessMethod =
  'verifyBeaconWithWitness(uint64,bytes,uint128,uint256)';
const inputMethod =
  'pairingInputForWitness(uint64,bytes,uint128,uint256)';

const rows = [];
let requestId = 0;
let stage = 'initialization';

async function rpc(method, params) {
  const id = ++requestId;
  let response;
  let body;

  try {
    response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new CheckError(`${method}: transport failure or timeout`);
  }

  check(response.ok, `${method}: HTTP ${response.status}`);

  try {
    body = await response.json();
  } catch {
    throw new CheckError(`${method}: invalid JSON`);
  }

  check(body?.id === id, `${method}: response ID mismatch`);

  if (body.error) {
    let detail = '';
    if (Number.isSafeInteger(body.error.code)) {
      detail = ` (code ${body.error.code})`;
    }
    throw new CheckError(`${method}: RPC error${detail}`);
  }

  check(Object.hasOwn(body, 'result'), `${method}: missing result`);
  return body.result;
}

function hexBody(value) {
  check(
    typeof value === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(value),
    'Invalid hex bytes',
  );
  return value.slice(2).toLowerCase();
}

function quantity(value) {
  check(
    typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value),
    'Invalid RPC quantity',
  );
  return BigInt(value);
}

function word(value) {
  const integer = BigInt(value);
  check(integer >= 0n && integer < (1n << 256n), 'ABI word out of range');
  return integer.toString(16).padStart(64, '0');
}

function wordAt(result, index) {
  const body = hexBody(result);
  check(body.length % 64 === 0, 'Unaligned ABI response');
  check(body.length >= (index + 1) * 64, 'Short ABI response');
  return BigInt(`0x${body.slice(index * 64, (index + 1) * 64)}`);
}

// Only the ABI types used by this runner: uints and dynamic bytes.
function calldata(artifact, method, values) {
  const selector = artifact.methodIdentifiers?.[method];
  check(
    /^[0-9a-f]{8}$/i.test(selector ?? ''),
    'Missing method identifier',
  );

  const types = method.slice(method.indexOf('(') + 1, -1).split(',');
  check(types.length === values.length, 'ABI argument count mismatch');

  let tail = '';
  const head = types.map((type, index) => {
    if (type !== 'bytes') {
      return word(values[index]);
    }

    const data = hexBody(values[index]);
    const offset = word(types.length * 32 + tail.length / 2);
    tail += word(data.length / 2);
    tail += data.padEnd(Math.ceil(data.length / 64) * 64, '0');
    return offset;
  });

  return `0x${selector}${head.join('')}${tail}`;
}

// Supports the return layouts bytes and (bool, bytes).
function decodedBytes(result, headIndex = 0) {
  const body = hexBody(result);
  const offset = (headIndex + 1) * 32;

  check(
    wordAt(result, headIndex) === BigInt(offset),
    'Unexpected ABI offset',
  );

  const length = wordAt(result, offset / 32);
  check(length <= 4096n, 'Unexpected response length');

  const size = Number(length);
  const start = (offset + 32) * 2;
  const end = start + size * 2;

  check(
    body.length === start + Math.ceil(size / 32) * 64,
    'Unexpected ABI response size',
  );
  check(/^0*$/.test(body.slice(end)), 'Nonzero ABI padding');

  return `0x${body.slice(start, end)}`;
}

function witnessArgs(round, signature, y) {
  check(y >= 0n && y < (1n << 384n), 'Witness exceeds ABI range');
  return [round, signature, y >> 256n, y & ((1n << 256n) - 1n)];
}

function compressed(x, larger = false) {
  const data = Buffer.from(x.toString(16).padStart(96, '0'), 'hex');
  data[0] |= 0x80;
  if (larger) {
    data[0] |= 0x20;
  }
  return `0x${data.toString('hex')}`;
}

function flipSign(signature) {
  const data = Buffer.from(hexBody(signature), 'hex');
  data[0] ^= 0x20;
  return `0x${data.toString('hex')}`;
}

function pairingFrames(frame) {
  const found = [];

  if (frame.to?.toLowerCase() === pairingAddress) {
    found.push(frame);
  }

  for (const child of frame.calls ?? []) {
    found.push(...pairingFrames(child));
  }

  return found;
}

function inspectPairing(frame, success, verified) {
  check(frame.type === 'STATICCALL', 'Pairing frame is not STATICCALL');
  check(
    quantity(frame.gas) === 500_000n,
    'Pairing budget differs from 500k',
  );
  check(
    hexBody(frame.input).length === 768 * 2,
    'Wrong pairing input size',
  );
  check(
    Boolean(frame.error) === !success,
    'Unexpected pairing call status',
  );

  if (success) {
    check(
      frame.output === `0x${word(Number(verified))}`,
      'Wrong pairing result',
    );
  } else {
    check(
      quantity(frame.gasUsed) === 500_000n,
      'Invalid point did not burn 500k',
    );
  }

  return {
    callSuccess: success,
    gasForwarded: quantity(frame.gas).toString(),
    gasUsed: quantity(frame.gasUsed).toString(),
  };
}

async function loadArtifact(name) {
  const path = `contracts/out/${name}.sol/${name}.json`;
  const artifact = JSON.parse(await readFile(path, 'utf8'));

  for (const field of ['bytecode', 'deployedBytecode']) {
    check(
      hexBody(artifact[field]?.object).length > 0,
      'Missing linked bytecode',
    );
  }

  const refs = artifact.deployedBytecode.immutableReferences ?? {};
  check(
    Object.values(refs).every((value) => value.length === 0),
    'Runtime has immutable references; constructor patching is required',
  );

  return artifact;
}

function digest(code) {
  return createHash('sha256')
    .update(Buffer.from(hexBody(code), 'hex'))
    .digest('hex');
}

async function main() {
  check(rpcUrl, 'QUICKNET_RPC_URL is required');

  const chainId = quantity(await rpc('eth_chainId', []));

  const verifier = await loadArtifact('DrandQuicknetBeaconVerifier');
  const harness = await loadArtifact('DrandQuicknetBeaconVerifierHarness');

  const corpus = JSON.parse(await readFile(
    'contracts/test/fixtures/quicknet-kat.json',
    'utf8',
  ));

  const positives = Object.values(corpus.positive);
  check(
    corpus.schemaVersion === 1 && positives.length === 12,
    'Unexpected corpus schema or positive count',
  );

  check(quantity(await rpc('eth_chainId', [])) === 4663n, 'Wrong chain');

  const block = await rpc('eth_getBlockByNumber', ['latest', false]);
  check(block?.number && block?.hash, 'Missing block');

  const sender = `0x${randomBytes(20).toString('hex')}`;
  const verifierAddress = `0x${randomBytes(20).toString('hex')}`;
  const harnessAddress = `0x${randomBytes(20).toString('hex')}`;

  for (const address of [sender, verifierAddress, harnessAddress]) {
    check(
      await rpc('eth_getCode', [address, block.number]) === '0x',
      'Temporary address already contains code',
    );
  }

  // These changes exist only inside each RPC simulation.
  // No precompile addresses are overridden.
  const overrides = {
    [sender]: { balance: '0x3635c9adc5dea00000' },
    [verifierAddress]: { code: verifier.deployedBytecode.object },
    [harnessAddress]: { code: harness.deployedBytecode.object },
  };

  function callObject(to, data) {
    const call = {
      from: sender,
      data,
      gas: '0x989680',
      gasPrice: '0x0',
    };
    if (to) {
      call.to = to;
    }
    return call;
  }

  async function call(to, data) {
    return rpc('eth_call', [
      callObject(to, data),
      block.number,
      overrides,
    ]);
  }

  async function trace(to, data) {
    const result = await rpc('debug_traceCall', [
      callObject(to, data),
      block.number,
      {
        tracer: 'callTracer',
        timeout: '10s',
        stateOverrides: overrides,
      },
    ]);

    check(result && !result.error, 'Top-level trace failed');
    return result;
  }

  for (const [name, artifact] of [
    ['verifier', verifier],
    ['harness', harness],
  ]) {
    stage = `${name} constructor`;

    // Omitting `to` executes creation bytecode, including the constructor.
    const result = await call(null, artifact.bytecode.object);
    check(
      result === artifact.deployedBytecode.object,
      'Constructor runtime mismatch',
    );

    const execution = await trace(null, artifact.bytecode.object);
    check(execution.output === result, 'Constructor trace output mismatch');

    const frames = pairingFrames(execution);
    check(frames.length === 4, 'Expected four constructor pairing calls');

    rows.push({
      label: stage,
      pairings: frames.map((frame, index) =>
        inspectPairing(frame, true, index % 2 === 0)),
    });
  }

  async function verify(
    label,
    round,
    signature,
    y,
    expected,
    randomness,
    pairingExpectation = null,
  ) {
    stage = label;

    let method = verifyMethod;
    let args = [round, signature];

    if (y !== null) {
      method = witnessMethod;
      args = witnessArgs(round, signature, y);
    }

    const data = calldata(verifier, method, args);
    const result = await call(verifierAddress, data);
    const expectedOutput =
      `0x${word(Number(expected))}${hexBody(randomness)}`;

    check(result === expectedOutput, 'Unexpected verifier response');

    const row = { label, verified: expected };

    if (pairingExpectation !== null) {
      const execution = await trace(verifierAddress, data);
      check(execution.output === result, 'Verifier trace output mismatch');

      const frames = pairingFrames(execution);
      check(
        frames.length === pairingExpectation.length,
        'Wrong pairing call count',
      );

      row.pairings = frames.map((frame, index) =>
        inspectPairing(frame, pairingExpectation[index], expected));
    }

    rows.push(row);
  }

  const zero = `0x${word(0)}`;

  for (const vector of positives) {
    check(
      hexBody(vector.uncompressed).length === 192,
      'Wrong coordinate size',
    );

    const y = BigInt(`0x${hexBody(vector.uncompressed).slice(96)}`);
    const round = BigInt(vector.round);

    check(
      `0x${digest(vector.signature)}` === vector.randomness,
      'Fixture randomness mismatch',
    );

    await verify(
      `${vector.id}: compressed`,
      round, vector.signature, null, true, vector.randomness, [true],
    );

    await verify(
      `${vector.id}: witness`,
      round, vector.signature, y, true, vector.randomness, [true],
    );

    await verify(
      `${vector.id}: opposite witness`,
      round, vector.signature, p - y, false, zero, [],
    );

    const flipped = flipSign(vector.signature);

    await verify(
      `${vector.id}: sign mismatch`,
      round, flipped, y, false, zero, [],
    );

    await verify(
      `${vector.id}: consistent sign flip`,
      round, flipped, p - y, false, zero, [true],
    );
  }

  const kat = positives.find((vector) => BigInt(vector.round) === 1000n);
  check(kat, 'Missing round-1000 KAT');

  const katY = BigInt(`0x${hexBody(kat.uncompressed).slice(96)}`);

  const early = [
    ['round zero', 0n, kat.signature, katY],
    ['x equals p', 1000n, compressed(p), katY],
    ['y equals p', 1000n, kat.signature, p],
    ['y exceeds p', 1000n, kat.signature, p + 1n],
    ['infinity', 1000n, compressed(0n), 0n],
  ];

  for (const length of [0, 47, 49, 96]) {
    const data = Buffer.alloc(length);
    if (length > 0) {
      data[0] = 0x80;
    }
    early.push([
      `length ${length}`,
      1000n,
      `0x${data.toString('hex')}`,
      katY,
    ]);
  }

  for (const flag of [0x00, 0xc0]) {
    const data = Buffer.from(hexBody(kat.signature), 'hex');
    data[0] = (data[0] & 0x3f) | flag;
    early.push([
      `flags ${flag}`,
      1000n,
      `0x${data.toString('hex')}`,
      katY,
    ]);
  }

  for (const [label, round, signature, y] of early) {
    await verify(label, round, signature, y, false, zero, []);
  }

  const x4Y = BigInt(
    '0x0a989badd40d6212b33cffc3f3763e9b' +
    'c760f988c9926b26da9dd85e928483446346b8ed00e1de5d5ea93e354abe706c',
  );

  const cases = [
    ['valid KAT', kat.signature, katY, true, true],
    [
      'negative KAT',
      flipSign(kat.signature),
      p - katY,
      true,
      false,
    ],
    ['off curve', kat.signature, katY + 1n, false, false],
    ['order three, small root', compressed(0n), 2n, false, false],
    [
      'order three, large root',
      compressed(0n, true),
      p - 2n,
      false,
      false,
    ],
    ['x4 non-subgroup', compressed(4n), x4Y, false, false],
  ];

  for (const [label, signature, y, success, verified] of cases) {
    stage = `raw pairing: ${label}`;

    const payload = decodedBytes(await call(
      harnessAddress,
      calldata(
        harness,
        inputMethod,
        witnessArgs(1000n, signature, y),
      ),
    ));

    check(
      hexBody(payload).length === 1536,
      'Expected 768-byte pairing input',
    );

    const data = calldata(harness, 'rawPairing(bytes)', [payload]);
    const result = await call(harnessAddress, data);

    check(
      wordAt(result, 0) === BigInt(Number(success)),
      'Wrong raw call status',
    );

    const returned = decodedBytes(result, 1);

    // Decode the outer harness response in all cases. Interpret the
    // precompile's returned bytes only when its call succeeded.
    if (success) {
      check(
        returned === `0x${word(Number(verified))}`,
        'Wrong raw pairing output',
      );
    }

    const execution = await trace(harnessAddress, data);
    check(execution.output === result, 'Raw trace output mismatch');

    const frames = pairingFrames(execution);
    check(frames.length === 1, 'Expected one raw pairing frame');
    check(frames[0].input === payload, 'Raw pairing input mismatch');

    rows.push({
      label: stage,
      pairing: inspectPairing(frames[0], success, verified),
    });

    let randomness = zero;
    if (verified) {
      randomness = kat.randomness;
    }

    await verify(
      `wrapper: ${label}`,
      1000n, signature, y, verified, randomness, [success],
    );
  }

  stage = 'final block check';

  const finalBlock = await rpc('eth_getBlockByNumber', [
    block.number,
    false,
  ]);
  check(finalBlock?.hash === block.hash, 'Block changed during run; rerun');

  console.log(JSON.stringify({
    status: 'PASS',
    chainId: chainId.toString(),
    block: quantity(block.number).toString(),
    blockHash: block.hash,
    verifierRuntimeSha256: digest(verifier.deployedBytecode.object),
    harnessRuntimeSha256: digest(harness.deployedBytecode.object),
    verifierInitcodeSha256: digest(verifier.bytecode.object),
    harnessInitcodeSha256: digest(harness.bytecode.object),
    checks: rows,
  }, null, 2));
}

main().catch((error) => {
  let detail = 'Local file, artifact, or unexpected response error';
  if (error instanceof CheckError) {
    detail = error.message;
  }

  console.error(`${stage}: ${detail}`);
  process.exitCode = 1;
});