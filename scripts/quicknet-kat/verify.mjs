import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { bls12_381 } from '@noble/curves/bls12-381.js';

// This audit intentionally imports no project cryptographic helpers.
const fixture = new URL('../../contracts/test/fixtures/quicknet-kat.json', import.meta.url);
const corpus = JSON.parse(await readFile(fixture, 'utf8'));

const dst = 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_';
const publicKey = Buffer.from(
  '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d106451' +
  '0d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
  'hex',
);

const p = BigInt('0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab');
const bls = bls12_381.shortSignatures;

function hex(bytes) {
  return `0x${Buffer.from(bytes).toString('hex')}`;
}

function bytes(value) {
  assert.equal(typeof value, 'string');
  assert.ok(value.startsWith('0x'));

  const result = Buffer.from(value.slice(2), 'hex');

  assert.equal(hex(result), value, 'fixture must use complete lowercase hex bytes');

  return result;
}

function hash(value) {
  return createHash('sha256').update(value).digest();
}

function canonical(signature) {
  if (signature.length !== 48 || (signature[0] & 0xc0) !== 0x80) {
    return false;
  }

  const coordinate = Buffer.from(signature);
  coordinate[0] &= 0x1f;

  return BigInt(hex(coordinate)) < p;
}

function message(round) {
  assert.ok(round >= 0n && round <= 0xffffffffffffffffn);

  const encoded = Buffer.alloc(8);
  encoded.writeBigUInt64BE(round);

  return bls.hash(hash(encoded), dst);
}

function verify(round, signature) {
  if (round === 0n || !canonical(signature)) {
    return false;
  }

  // Restrict exception-as-rejection to point decoding. A broken hash or
  // pairing implementation must fail this audit, not pass a negative KAT.
  let point;
  try {
    point = bls12_381.G1.Point.fromBytes(signature);
    point.assertValidity();
  } catch {
    return false;
  }

  return bls.verify(point, message(round), publicKey);
}

// Independent witness oracle: compare the supplied integer y with Noble's
// decoding of the compressed signature, then verify the decoded point.
// Solidity's uint128/uint256 limb handling is tested by the Foundry suite.
function verifyWithWitness(round, signature, y) {
  if (
    round === 0n ||
    !canonical(signature) ||
    y < 0n ||
    y >= p
  ) {
    return false;
  }

  // Only point decoding/validation errors count as invalid input.
  // Hashing, serialization, and pairing errors must fail the audit.
  let point;
  try {
    point = bls12_381.G1.Point.fromBytes(signature);
    point.assertValidity();
  } catch {
    return false;
  }

  const uncompressed = point.toBytes(false);
  assert.equal(uncompressed.length, 96);

  const expectedY = BigInt(hex(uncompressed.subarray(48)));

  if (y !== expectedY) {
    return false;
  }

  return bls.verify(point, message(round), publicKey);
}

assert.equal(corpus.schemaVersion, 1);
assert.equal(corpus.quicknet.dst, dst);
assert.equal(corpus.quicknet.publicKey, hex(publicKey));
assert.equal(corpus.quicknet.chainHash, '0x52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971');
assert.equal(corpus.quicknet.scheme, 'bls-unchained-g1-rfc9380');
assert.equal(Object.keys(corpus.positive).length, 12);
assert.equal(Object.keys(corpus.negative).length, 31);

const seen = new Set();
for (const [index, vector] of Object.values(corpus.positive).entries()) {
  assert.equal(corpus.positive[`v${index}`], vector, 'contiguous vector keys');

  const round = BigInt(vector.round);

  assert.ok(!seen.has(round), 'duplicate positive round');

  seen.add(round);

  const signature = bytes(vector.signature);

  assert.equal(verify(round, signature), true, vector.id);
  assert.equal(hex(hash(signature)), vector.randomness, vector.id);
  assert.equal(
    hex(bls12_381.G1.Point.fromBytes(signature).toBytes(false)),
    vector.uncompressed,
    `${vector.id}: independent decompression`,
  );

  const uncompressed = bytes(vector.uncompressed);
  assert.equal(uncompressed.length, 96, vector.id);

  const y = BigInt(hex(uncompressed.subarray(48)));
  const oppositeY = p - y;

  assert.equal(
    verifyWithWitness(round, signature, y),
    true,
    `${vector.id}: independent witness`,
  );

  assert.equal(
    verifyWithWitness(0n, signature, y),
    false,
    `${vector.id}: witness round zero`,
  );

  assert.equal(
    verifyWithWitness(round, signature, oppositeY),
    false,
    `${vector.id}: original signature with opposite root`,
  );

  assert.equal(
    verifyWithWitness(round, signature, p),
    false,
    `${vector.id}: witness y equals p`,
  );

  assert.equal(
    verifyWithWitness(round, signature, p + 1n),
    false,
    `${vector.id}: witness y exceeds p`,
  );

  assert.equal(
    verifyWithWitness(round, signature, y + 1n),
    false,
    `${vector.id}: mutated witness`,
  );

  for (let byteIndex = 0n; byteIndex < 8n; byteIndex++) {
    const mask = 1n << (8n * byteIndex);
    const wrongRound = round ^ mask;

    assert.equal(
      verify(wrongRound, signature),
      false,
      `${vector.id}: wrong round`,
    );

    assert.equal(
      verifyWithWitness(wrongRound, signature, y),
      false,
      `${vector.id}: witness wrong round`,
    );
  }

  const flipped = Buffer.from(signature);
  flipped[0] ^= 0x20;

  assert.equal(verify(round, flipped), false, `${vector.id}: sign flip`);

  assert.equal(
    verifyWithWitness(round, flipped, y),
    false,
    `${vector.id}: flipped signature with original root`,
  );

  assert.equal(
    verifyWithWitness(round, flipped, oppositeY),
    false,
    `${vector.id}: consistently encoded negative signature`,
  );
}

for (const [index, vector] of Object.values(corpus.negative).entries()) {
  assert.equal(corpus.negative[`v${index}`], vector, 'contiguous vector keys');
  
  const signature = bytes(vector.signature);

  assert.equal(canonical(signature), vector.canonical, vector.id);
  assert.equal(verify(BigInt(vector.round), signature), false, vector.id);
}

// This is mandatory for v30: deleting its source metadata must fail the audit.
// Rejection under Quicknet alone would not establish a real wrong-key beacon.
const wrongKeyVector = corpus.negative.v30;
assert.equal(wrongKeyVector.id, 'quicknet-t-round-1000-wrong-key');
assert.equal(wrongKeyVector.round, '1000');
assert.equal(wrongKeyVector.canonical, true);

const source = wrongKeyVector.source;
assert.equal(source.beaconId, 'quicknet-t');
assert.equal(
  source.chainHash,
  '0xcc9c398442737cbd141526600919edd69f1d6f9b4adb67e4d912fbc64341a9a5',
);
assert.equal(
  source.publicKey,
  '0xb15b65b46fb29104f6a4b5d1e11a8da6344463973d423661bb0804846a0ecd1ef93c25057f1c0baab2ac53e56c662b66' +
  '072f6d84ee791a3382bfb055afab1e6a375538d8ffc451104ac971d2dc9b168e2d3246b0be2015969cbaac298f6502da',
);
assert.equal(source.scheme, corpus.quicknet.scheme);
assert.notEqual(source.chainHash, corpus.quicknet.chainHash);
assert.notEqual(source.publicKey, corpus.quicknet.publicKey);
assert.ok(
  seen.has(BigInt(wrongKeyVector.round)),
  'wrong-key round must also have a Quicknet positive',
);

const wrongKeySignature = bytes(wrongKeyVector.signature);
const sourceKey = bytes(source.publicKey);

assert.equal(sourceKey.length, 96);
assert.equal(
  hex(hash(wrongKeySignature)),
  source.randomness,
  'source published randomness',
);

// No catch: malformed points, invalid keys, and cryptographic errors fail.
const wrongKeyPoint = bls12_381.G1.Point.fromBytes(wrongKeySignature);
wrongKeyPoint.assertValidity();

assert.equal(
  bls.verify(
    wrongKeyPoint,
    message(BigInt(wrongKeyVector.round)),
    sourceKey,
  ),
  true,
  'quicknet-t beacon must verify under its source key',
);

console.log(
  `Quicknet KAT audit passed: ${seen.size} published rounds, ` +
  `${Object.keys(corpus.negative).length} fixed negatives, ` +
  `${seen.size * 9} derived round/sign negatives, 1 source-key acceptance.`,
);

console.log(
  'Independent witness audit passed: ' +
  `${seen.size} acceptances and ${seen.size * 15} rejections.`,
);