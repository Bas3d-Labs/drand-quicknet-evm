import {
  http,
  type HttpTransport,
  type HttpTransportConfig,
} from 'viem';

import type {
  RpcClientRole,
  RpcMetrics,
} from '../diagnostics/rpc-metrics.js';

export function measuredHttp(
  url: string,
  metrics: RpcMetrics,
  client: RpcClientRole,
  config: HttpTransportConfig = {},
): HttpTransport {
  const fetchFn = config.fetchFn ?? globalThis.fetch;

  const factory = http(url, {
    ...config,
    fetchFn: (input, init) => metrics.http(
      client,
      () => fetchFn(input, init),
    ),
  });

  return (options) => {
    const transport = factory(options);

    const request: typeof transport.request = (
      args,
      requestOptions,
    ) => metrics.logical(
      client,
      args.method,
      () => transport.request(args, requestOptions),
    );

    // Preserve viem's retry, timeout, batching, and request-option behavior.
    return {
      ...transport,
      request,
    };
  }
}