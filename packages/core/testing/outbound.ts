/** Header carrying the URL the Worker meant to fetch, on requests sent to the test process. */
export const ORIGINAL_URL_HEADER = "x-test-original-url";

const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Routes the test Worker's outgoing requests (its own and its Durable
 * Objects', which share the isolate): `answer` may answer one inside the
 * Worker (email's offline DNS-over-HTTPS), and every other request to the
 * internet goes to the stack suite's process at `testProcess`, which
 * answers it from the running test or passes it through (internet.ts).
 * Requests to loopback addresses (the Worker itself) are left alone.
 */
export function routeOutboundFetch(
  testProcess: string,
  answer?: (request: Request) => Response | undefined
) {
  const fetchInternet = globalThis.fetch;

  const routed = (...[input, init]: Parameters<typeof fetch>) => {
    const request = new Request(input, init);
    const answered = answer?.(request);

    if (answered) return Promise.resolve(answered);
    const url = new URL(request.url);

    if (loopback.has(url.hostname)) return fetchInternet(request);
    const forwarded = new Request(testProcess, request);
    forwarded.headers.set(ORIGINAL_URL_HEADER, request.url);

    return fetchInternet(forwarded);
  };

  // Whatever else the runtime's fetch has (Bun's `preconnect`) stays as it was.
  globalThis.fetch = Object.assign(routed, {
    preconnect: fetchInternet.preconnect,
  });
}
