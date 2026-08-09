import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { fetchBeacon, fetchBeaconFromEndpoint } from '../src/fetch.js';

const VALID_SIGNATURE = 'ab'.repeat(48);

function mockResponse(
  body: unknown,
  status = 200,
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  };
}

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


describe('fetchBeacon', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the first endpoint when it succeeds', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({
        round: 100,
        signature: VALID_SIGNATURE,
      }),
    );

    vi.stubGlobal('fetch', fetchMock);

    const beacon = await fetchBeacon(
      100n,
      [
        'https://first.test/v2',
        'https://second.test/v2',
      ],
    );

    expect(beacon).toEqual({
      round: 100n,
      signature: `0x${VALID_SIGNATURE}`,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://first.test/v2/beacons/quicknet/rounds/100',
    );
  });

  it('falls back to the second endpoint when the first returns an HTTP error', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse(undefined, 503),
      )
      .mockResolvedValueOnce(
        mockResponse({
          round: 100,
          signature: VALID_SIGNATURE,
        }),
      );

    vi.stubGlobal('fetch', fetchMock);

    const beacon = await fetchBeacon(
      100n,
      [
        'https://first.test/v2',
        'https://second.test/v2',
      ],
    );

    expect(beacon).toEqual({
      round: 100n,
      signature: `0x${VALID_SIGNATURE}`,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://first.test/v2/beacons/quicknet/rounds/100',
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://second.test/v2/beacons/quicknet/rounds/100',
    );
  });

  it('falls back when the first endpoint returns the wrong round', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse({
          round: 101,
          signature: VALID_SIGNATURE,
        }),
      )
      .mockResolvedValueOnce(
        mockResponse({
          round: 100,
          signature: VALID_SIGNATURE,
        }),
      );

    vi.stubGlobal('fetch', fetchMock);

    const beacon = await fetchBeacon(
      100n,
      [
        'https://first.test/v2',
        'https://second.test/v2',
      ],
    );

    expect(beacon).toEqual({
      round: 100n,
      signature: `0x${VALID_SIGNATURE}`,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back when the first endpoint returns an invalid signature', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse({
          round: 100,
          signature: 'not-a-valid-signature',
        }),
      )
      .mockResolvedValueOnce(
        mockResponse({
          round: 100,
          signature: VALID_SIGNATURE,
        }),
      );

    vi.stubGlobal('fetch', fetchMock);

    const beacon = await fetchBeacon(
      100n,
      [
        'https://first.test/v2',
        'https://second.test/v2',
      ],
    );

    expect(beacon).toEqual({
      round: 100n,
      signature: `0x${VALID_SIGNATURE}`,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back when fetch itself throws', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(
        new Error('Network unavailable'),
      )
      .mockResolvedValueOnce(
        mockResponse({
          round: 100,
          signature: VALID_SIGNATURE,
        }),
      );

    vi.stubGlobal('fetch', fetchMock);

    const beacon = await fetchBeacon(
      100n,
      [
        'https://first.test/v2',
        'https://second.test/v2',
      ],
    );

    expect(beacon).toEqual({
      round: 100n,
      signature: `0x${VALID_SIGNATURE}`,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops trying endpoints after one succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse(undefined, 500),
      )
      .mockResolvedValueOnce(
        mockResponse({
          round: 100,
          signature: VALID_SIGNATURE,
        }),
      )
      .mockResolvedValueOnce(
        mockResponse({
          round: 100,
          signature: VALID_SIGNATURE,
        }),
      );

    vi.stubGlobal('fetch', fetchMock);

    await fetchBeacon(
      100n,
      [
        'https://first.test/v2',
        'https://second.test/v2',
        'https://third.test/v2',
      ],
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);

    expect(fetchMock).not.toHaveBeenCalledWith(
      'https://third.test/v2/beacons/quicknet/rounds/100',
    );
  });

  it('rejects an empty endpoint list without making a request', async () => {
    const fetchMock = vi.fn();

    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchBeacon(100n, []),
    ).rejects.toThrow(
      'At least one Quicknet endpoint is required.',
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws an AggregateError when every endpoint fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse(undefined, 500),
      )
      .mockResolvedValueOnce(
        mockResponse({
          round: 101,
          signature: VALID_SIGNATURE,
        }),
      )
      .mockResolvedValueOnce(
        mockResponse({
          round: 100,
          signature: 'invalid',
        }),
      );

    vi.stubGlobal('fetch', fetchMock);

    try {
      await fetchBeacon(
        100n,
        [
          'https://first.test/v2',
          'https://second.test/v2',
          'https://third.test/v2',
        ],
      );

      expect.fail(
        'Expected fetchBeacon to throw',
      );
    } catch (error) {
      expect(error).toBeInstanceOf(
        AggregateError,
      );

      expect(error).toHaveProperty(
        'message',
        'Failed to fetch Quicknet round 100 from all endpoints.',
      );

      const aggregateError =
        error as AggregateError;

      expect(aggregateError.errors).toHaveLength(
        3,
      );
    }

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('preserves the individual endpoint errors in the AggregateError', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse(undefined, 503),
      )
      .mockResolvedValueOnce(
        mockResponse({
          round: 101,
          signature: VALID_SIGNATURE,
        }),
      );

    vi.stubGlobal('fetch', fetchMock);

    try {
      await fetchBeacon(
        100n,
        [
          'https://first.test/v2',
          'https://second.test/v2',
        ],
      );

      expect.fail(
        'Expected fetchBeacon to throw',
      );
    } catch (error) {
      expect(error).toBeInstanceOf(
        AggregateError,
      );

      const aggregateError =
        error as AggregateError;

      expect(aggregateError.errors).toHaveLength(
        2,
      );

      expect(
        aggregateError.errors[0],
      ).toHaveProperty(
        'message',
        'Failed to fetch Quicknet round 100: HTTP 503',
      );

      expect(
        aggregateError.errors[1],
      ).toHaveProperty(
        'message',
        'Quicknet round mismatch: requested 100, received 101',
      );
    }
  });

  it('converts a non-Error rejection into an Error', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(
        'network failure',
      );

    vi.stubGlobal('fetch', fetchMock);

    try {
      await fetchBeacon(
        100n,
        ['https://first.test/v2'],
      );

      expect.fail(
        'Expected fetchBeacon to throw',
      );
    } catch (error) {
      expect(error).toBeInstanceOf(
        AggregateError,
      );

      const aggregateError =
        error as AggregateError;

      expect(aggregateError.errors).toHaveLength(
        1,
      );

      expect(
        aggregateError.errors[0],
      ).toBeInstanceOf(Error);

      expect(
        aggregateError.errors[0],
      ).toHaveProperty(
        'message',
        'network failure',
      );
    }
  });
});

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
  })
});