import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { fetchBeaconFromEndpoint } from '../src/fetch.js';

const VALID_SIGNATURE = 'ab'.repeat(48);

function mockFetchResponse({
  ok = true,
  status = 200,
  body,
}: {
  ok?: boolean;
  status?: number;
  body?: unknown;
}) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    json: vi.fn().mockResolvedValue(body),
  });

  vi.stubGlobal('fetch', fetchMock);

  return fetchMock;
}

describe('fetchBeaconFromEndpoint', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches and returns the exact requested round', async () => {
    mockFetchResponse({
      body: {
        round: 100,
        signature: VALID_SIGNATURE,
      },
    });

    const beacon = await fetchBeaconFromEndpoint(
      'https://example.test/v2',
      100n,
    );

    expect(beacon).toEqual({
      round: 100n,
      signature: `0x${VALID_SIGNATURE}`,
    });
  });

  it('constructs the correct exact-round URL', async () => {
    const fetchMock = mockFetchResponse({
      body: {
        round: 100,
        signature: VALID_SIGNATURE,
      },
    });

    await fetchBeaconFromEndpoint(
      'https://example.test/v2',
      100n,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.test/v2/beacons/quicknet/rounds/100',
    );
  });

  it('removes trailing slashes from the endpoint', async () => {
    const fetchMock = mockFetchResponse({
      body: {
        round: 100,
        signature: VALID_SIGNATURE,
      },
    });

    await fetchBeaconFromEndpoint(
      'https://example.test/v2///',
      100n,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.test/v2/beacons/quicknet/rounds/100',
    );
  });

  it('rejects round zero before making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchBeaconFromEndpoint(
        'https://example.test/v2',
        0n,
      ),
    ).rejects.toThrow(
      'Quicknet round must be greater than zero.',
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a negative round before making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchBeaconFromEndpoint(
        'https://example.test/v2',
        -1n,
      ),
    ).rejects.toThrow(RangeError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a non-successful HTTP response', async () => {
    mockFetchResponse({
      ok: false,
      status: 404,
    });

    await expect(
      fetchBeaconFromEndpoint(
        'https://example.test/v2',
        100n,
      ),
    ).rejects.toThrow(
      'Failed to fetch Quicknet round 100: HTTP 404',
    );
  });

  it('rejects a missing response round', async () => {
    mockFetchResponse({
      body: {
        signature: VALID_SIGNATURE,
      },
    });

    await expect(
      fetchBeaconFromEndpoint(
        'https://example.test/v2',
        100n,
      ),
    ).rejects.toThrow(
      'Invalid Quicknet response: invalid round',
    );
  });

  it('rejects a response round that is not a number', async () => {
    mockFetchResponse({
      body: {
        round: '100',
        signature: VALID_SIGNATURE,
      },
    });

    await expect(
      fetchBeaconFromEndpoint(
        'https://example.test/v2',
        100n,
      ),
    ).rejects.toThrow(
      'Invalid Quicknet response: invalid round',
    );
  });

  it('rejects a fractional response round', async () => {
    mockFetchResponse({
      body: {
        round: 100.5,
        signature: VALID_SIGNATURE,
      },
    });

    await expect(
      fetchBeaconFromEndpoint(
        'https://example.test/v2',
        100n,
      ),
    ).rejects.toThrow(
      'Invalid Quicknet response: invalid round',
    );
  });

  it('rejects an unsafe integer response round', async () => {
    mockFetchResponse({
      body: {
        round: Number.MAX_SAFE_INTEGER + 1,
        signature: VALID_SIGNATURE,
      },
    });

    await expect(
      fetchBeaconFromEndpoint(
        'https://example.test/v2',
        100n,
      ),
    ).rejects.toThrow(
      'Invalid Quicknet response: invalid round',
    );
  });

  it('rejects a different returned round', async () => {
    mockFetchResponse({
      body: {
        round: 101,
        signature: VALID_SIGNATURE,
      },
    });

    await expect(
      fetchBeaconFromEndpoint(
        'https://example.test/v2',
        100n,
      ),
    ).rejects.toThrow(
      'Quicknet round mismatch: requested 100, received 101',
    );
  });

  it('rejects a missing signature', async () => {
    mockFetchResponse({
      body: {
        round: 100,
      },
    });

    await expect(
      fetchBeaconFromEndpoint(
        'https://example.test/v2',
        100n,
      ),
    ).rejects.toThrow(
      'Invalid compressed Quicknet signature: expected a string',
    );
  });

  it('rejects a non-string signature', async () => {
    mockFetchResponse({
      body: {
        round: 100,
        signature: 123,
      },
    });

    await expect(
      fetchBeaconFromEndpoint(
        'https://example.test/v2',
        100n,
      ),
    ).rejects.toThrow(
      'Invalid compressed Quicknet signature: expected a string',
    );
  });

  it('rejects a malformed compressed signature', async () => {
    mockFetchResponse({
      body: {
        round: 100,
        signature: 'ab'.repeat(47),
      },
    });

    await expect(
      fetchBeaconFromEndpoint(
        'https://example.test/v2',
        100n,
      ),
    ).rejects.toThrow(
      'Invalid compressed Quicknet signature: expected 48 bytes',
    );
  });

  it('rejects non-hex signature data', async () => {
    mockFetchResponse({
      body: {
        round: 100,
        signature: `${'ab'.repeat(47)}ag`,
      },
    });

    await expect(
      fetchBeaconFromEndpoint(
        'https://example.test/v2',
        100n,
      ),
    ).rejects.toThrow(
      'Invalid compressed Quicknet signature: contains non-hex characters',
    );
  });

  it('normalizes an uppercase signature to lowercase', async () => {
    const uppercaseSignature = 'AB'.repeat(48);

    mockFetchResponse({
      body: {
        round: 100,
        signature: uppercaseSignature,
      },
    });

    const beacon = await fetchBeaconFromEndpoint(
      'https://example.test/v2',
      100n,
    );

    expect(beacon.signature).toBe(
      `0x${uppercaseSignature.toLowerCase()}`,
    );
  });
});