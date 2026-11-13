import { ORIGINAL_URL_HEADER } from "./outbound.ts";

/**
 * The internet as the test Worker sees it. The Worker sends its outgoing
 * requests here (outbound.ts); a test answers the ones it
 * cares about with `internet.handle(...)`, and the rest go out unchanged.
 * Handlers and the request log are
 * cleared after every test (harness.ts).
 */

export type OutboundRequest = Request & {
  /** The URL the Worker fetched. */
  readonly target: URL;
};

/** Answers a request, or returns undefined to leave it to the next handler. */
export type OutboundHandler = (
  request: OutboundRequest
) => Response | undefined | Promise<Response | undefined>;

type Internet = {
  handlers: OutboundHandler[];
  requests: {
    url: string;
    method: string;
    headers: Headers;
    body: string;
  }[];
};

declare global {
  // One instance per process, whichever module graph imports it.
  // oxlint-disable-next-line no-var -- a global declaration names a property of globalThis
  var __stackInternet: Internet | undefined;
}

// oxlint-disable-next-line no-multi-assign -- one shared instance per process
const state: Internet = (globalThis.__stackInternet ??= {
  handlers: [],
  requests: [],
});

export const internet = {
  /** Answers matching requests for the rest of the test; later handlers go first. */
  handle(handler: OutboundHandler) {
    state.handlers.unshift(handler);
  },
  /** What the Worker fetched during this test, oldest first. */
  get requests(): readonly {
    url: string;
    method: string;
    headers: Headers;
    body: string;
  }[] {
    return state.requests;
  },
  reset() {
    state.handlers.length = 0;
    state.requests.length = 0;
  },
};

/**
 * The answer of the first handler that has one, asking them in order: a
 * handler runs only when every one before it declined.
 */
async function firstAnswer(
  handlers: readonly OutboundHandler[],
  request: () => OutboundRequest
): Promise<Response | undefined> {
  const [handler, ...rest] = handlers;

  if (!handler) return undefined;

  return (await handler(request())) ?? firstAnswer(rest, request);
}

async function answer(incoming: Request) {
  const url = incoming.headers.get(ORIGINAL_URL_HEADER);

  if (!url) return new Response("Not an outbound request", { status: 400 });
  const headers = new Headers(incoming.headers);
  headers.delete(ORIGINAL_URL_HEADER);
  headers.delete("host");

  const body = ["GET", "HEAD"].includes(incoming.method)
    ? undefined
    : await incoming.arrayBuffer();

  state.requests.push({
    url,
    method: incoming.method,
    headers,
    body: body ? new TextDecoder().decode(body) : "",
  });

  const handled = await firstAnswer(state.handlers, () =>
    Object.assign(
      new Request(url, { method: incoming.method, headers, body }),
      {
        target: new URL(url),
      }
    )
  );

  if (handled) return handled;
  let response: Response;

  try {
    response = await fetch(url, {
      method: incoming.method,
      headers,
      body,
      redirect: "manual",
    });
  } catch (error) {
    // Unreachable (often a test host whose handler went with its test, hit
    // by a queue retry later): a gateway error for the Worker, rather than
    // an error thrown into whichever test is running now.
    return new Response(`The test process could not reach ${url}: ${error}`, {
      status: 502,
    });
  }

  // Bun has already decoded the body.
  const passed = new Headers(response.headers);
  passed.delete("content-encoding");
  passed.delete("content-length");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: passed,
  });
}

/** Serves the Worker's outgoing requests until the process exits. */
export function serveInternet() {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: answer });

  return `http://127.0.0.1:${server.port}/`;
}
