import {
  describe,
  expect,
  expectTypeOf,
  it,
} from 'vitest';

import {
  DaemonHeartbeatViews,
  type DiscoveryHeartbeatView,
  type DurableHeartbeatView,
} from '../../src/daemon/daemon-heartbeat-views.js';

const CONSUMER = `0x${'ab'.repeat(20)}` as const;

const SECOND_CONSUMER = `0x${'cd'.repeat(20)}` as const;

const DISCOVERY = {
  latestBlock: 120n,
  softNextBlock: 121n,
  latestBlockObservedAt: '2026-11-21T00:00:10.000Z',
};

const DURABLE = {
  durableBlock: 100n,
  durableNextBlock: 91n,
  durableBlockObservedAt: '2026-11-21T00:00:00.000Z',
};

describe('daemon heartbeat views', () => {
  it.each(['discovery', 'full'] as const)(
    'does not report healthy before both views exist, with %s first',
    (first) => {
      const views = new DaemonHeartbeatViews([CONSUMER]);

      const missing = [{ consumer: CONSUMER, status: 'failed' }];

      expect(views.snapshot()).toEqual(missing);

      if (first === 'discovery') {
        views.discoveryCompleted(CONSUMER, DISCOVERY);
      } else {
        views.fullCompleted(CONSUMER, DURABLE);
      }

      expect(views.snapshot()).toEqual(missing);

      views.discoveryCompleted(CONSUMER, DISCOVERY);
      views.fullCompleted(CONSUMER, DURABLE);

      expect(views.snapshot()).toEqual([{
        consumer: CONSUMER,
        status: 'healthy',
        ...DISCOVERY,
        ...DURABLE,
      }]);
    },
  );

  it('allows full work to update only the durable view, retaining cached observation time', () => {
    const views = new DaemonHeartbeatViews([CONSUMER]);

    views.discoveryCompleted(CONSUMER, DISCOVERY);
    views.fullCompleted(CONSUMER, DURABLE);

    // A scan adapter can hold a wider result at runtime. Copying explicit
    // fields prevents that full-work head from replacing the discovery pair.
    const fullResult = {
      ...DURABLE,
      durableNextBlock: 101n,
      ...DISCOVERY,
      latestBlock: 150n,
      softNextBlock: 151n,
      latestBlockObservedAt: '2026-11-21T00:00:20.000Z',
    };

    views.fullCompleted(CONSUMER, fullResult);

    expect(views.snapshot()).toEqual([{
      consumer: CONSUMER,
      status: 'healthy',
      ...DISCOVERY,
      ...DURABLE,
      durableNextBlock: 101n,
    }]);

    expectTypeOf<keyof DurableHeartbeatView>().toEqualTypeOf<
      'durableBlock' | 'durableNextBlock' | 'durableBlockObservedAt'
    >();
    expectTypeOf<keyof DiscoveryHeartbeatView>().toEqualTypeOf<
      'latestBlock' | 'softNextBlock' | 'latestBlockObservedAt'
    >();
  });

  it('updates discovery as a pair without replacing the durable observation', () => {
    const views = new DaemonHeartbeatViews([CONSUMER]);

    views.discoveryCompleted(CONSUMER, DISCOVERY);
    views.fullCompleted(CONSUMER, DURABLE);
    views.discoveryCompleted(CONSUMER, {
      ...DISCOVERY,
      latestBlock: 150n,
      softNextBlock: 141n,
      latestBlockObservedAt: '2026-11-21T00:00:30.000Z',
    });

    expect(views.snapshot()).toEqual([{
      consumer: CONSUMER,
      status: 'healthy',
      ...DURABLE,
      latestBlock: 150n,
      softNextBlock: 141n,
      latestBlockObservedAt: '2026-11-21T00:00:30.000Z',
    }]);
  });

  it('keeps a discovery failure visible across full completions until discovery succeeds', () => {
    const views = new DaemonHeartbeatViews([CONSUMER]);

    views.discoveryCompleted(CONSUMER, DISCOVERY);
    views.fullCompleted(CONSUMER, DURABLE);
    views.discoveryFailed(CONSUMER);
    views.fullCompleted(CONSUMER, { ...DURABLE, durableNextBlock: 101n });

    expect(views.snapshot()).toEqual([{ consumer: CONSUMER, status: 'failed' }]);

    views.discoveryCompleted(CONSUMER, DISCOVERY);

    expect(views.snapshot()).toEqual([{
      consumer: CONSUMER,
      status: 'healthy',
      ...DISCOVERY,
      ...DURABLE,
      durableNextBlock: 101n,
    }]);
  });

  it('keeps a full-work failure visible across successful discovery', () => {
    const views = new DaemonHeartbeatViews([CONSUMER]);

    views.discoveryCompleted(CONSUMER, DISCOVERY);
    views.fullCompleted(CONSUMER, DURABLE);
    views.fullFailed(CONSUMER);
    views.discoveryCompleted(CONSUMER, DISCOVERY);

    expect(views.snapshot()).toEqual([{ consumer: CONSUMER, status: 'failed' }]);

    views.fullCompleted(CONSUMER, DURABLE);

    expect(views.snapshot()[0]?.status).toBe('healthy');
  });

  it('does not invent or retain observation times absent from a replacement reading', () => {
    const views = new DaemonHeartbeatViews([CONSUMER]);

    views.discoveryCompleted(CONSUMER, DISCOVERY);
    views.fullCompleted(CONSUMER, DURABLE);
    views.discoveryCompleted(CONSUMER, { latestBlock: 130n, softNextBlock: 131n });
    views.fullCompleted(CONSUMER, { durableBlock: 110n, durableNextBlock: 111n });

    const expected = [{
      consumer: CONSUMER,
      status: 'healthy',
      latestBlock: 130n,
      softNextBlock: 131n,
      durableBlock: 110n,
      durableNextBlock: 111n,
    }];

    expect(views.snapshot()).toEqual(expected);
    expect(views.snapshot()).toEqual(expected);
  });

  it('isolates caller mutations and returned rows from stored observations', () => {
    const views = new DaemonHeartbeatViews([CONSUMER]);

    const discovery = { ...DISCOVERY };

    const durable = { ...DURABLE };

    views.discoveryCompleted(CONSUMER, discovery);
    views.fullCompleted(CONSUMER, durable);

    discovery.latestBlock = 999n;
    durable.durableNextBlock = 999n;

    const row = views.snapshot()[0]!;

    expect(row.status).toBe('healthy');

    if (row.status === 'healthy') {
      row.latestBlock = 888n;
      row.durableNextBlock = 888n;
    }

    expect(views.snapshot()).toEqual([{
      consumer: CONSUMER,
      status: 'healthy',
      ...DISCOVERY,
      ...DURABLE,
    }]);
  });

  it('keeps consumer failures separate and resolves address casing without adding consumers', () => {
    const views = new DaemonHeartbeatViews([CONSUMER, SECOND_CONSUMER]);

    const uppercase = `0x${'AB'.repeat(20)}` as const;

    views.discoveryCompleted(uppercase, DISCOVERY);
    views.fullCompleted(uppercase, DURABLE);
    views.discoveryCompleted(SECOND_CONSUMER, DISCOVERY);
    views.fullCompleted(SECOND_CONSUMER, DURABLE);
    views.discoveryFailed(SECOND_CONSUMER);

    expect(views.snapshot()).toEqual([
      { consumer: CONSUMER, status: 'healthy', ...DISCOVERY, ...DURABLE },
      { consumer: SECOND_CONSUMER, status: 'failed' },
    ]);
    expect(() => views.fullCompleted(`0x${'ef'.repeat(20)}`, DURABLE))
      .toThrow('Unknown heartbeat consumer.');
    expect(views.snapshot()).toHaveLength(2);
  });
});
