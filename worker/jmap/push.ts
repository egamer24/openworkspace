import { MAILBOX_REALTIME_UPDATE } from "../../shared/mail";
import { mailboxStub } from "../mailbox";
import { encodeState } from "./ids";
import { currentState, type Account } from "./methods";

// Every Email, Thread, Mailbox, and EmailSubmission state is the account state.
const PUSH_TYPES = ["Email", "Thread", "Mailbox", "EmailSubmission"];
const MIN_PING_SECONDS = 10;
const MAX_PING_SECONDS = 600;

/**
 * JMAP push over EventSource (RFC 8620 section 7.3). The Worker opens one
 * hibernatable realtime WebSocket per OpenWorkspace mailbox, the same
 * invalidation the web app uses, and turns each update into a StateChange
 * when the account state actually moved. The DO re-checks the token on every
 * broadcast, so a revoked token ends the stream at the next change.
 */
export async function eventSource(input: {
  env: Env;
  account: Account;
  tokenId: string;
  tokenHash: string;
  url: URL;
  signal: AbortSignal;
}) {
  const { env, account, url } = input;
  const requested = (url.searchParams.get("types") ?? "*").split(",");
  const types = requested.includes("*") ? PUSH_TYPES : PUSH_TYPES.filter((type) => requested.includes(type));
  const closeAfterState = url.searchParams.get("closeafter") === "state";
  const requestedPing = Number(url.searchParams.get("ping") ?? 0);
  const ping = Number.isSafeInteger(requestedPing) && requestedPing > 0
    ? Math.min(Math.max(requestedPing, MIN_PING_SECONDS), MAX_PING_SECONDS)
    : 0;

  const sockets = await Promise.all(account.mailboxes.map(async (mailbox) => {
    const response = await mailboxStub(env, mailbox.id).fetch("https://mailbox.internal/realtime", {
      headers: {
        upgrade: "websocket",
        "x-openworkspace-user-id": account.userId,
        "x-openworkspace-session-id": input.tokenId,
        "x-openworkspace-session-token-hash": input.tokenHash,
        // Hidden sockets never suppress the user's web push notifications.
        "x-openworkspace-visibility": "hidden",
      },
    });
    const socket = response.webSocket;
    if (!socket) throw new Error(`Mailbox ${mailbox.id} refused the realtime connection`);
    socket.accept();
    return socket;
  }));

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let lastState = encodeState(await currentState({ env, account }));
  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    for (const socket of sockets) {
      try {
        socket.close(1000, "Event stream closed");
      } catch {
        // Already closed by the mailbox.
      }
    }
    writer.close().catch(() => {});
  };
  const send = (event: string, data: unknown) =>
    writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)).catch(close);

  // Updates are serialized so each StateChange reports a newer state.
  let queue = Promise.resolve();
  const onUpdate = () => {
    queue = queue.then(async () => {
      if (closed) return;
      const state = encodeState(await currentState({ env, account }));
      if (state === lastState) return;
      lastState = state;
      if (types.length) {
        await send("state", {
          "@type": "StateChange",
          changed: { [account.id]: Object.fromEntries(types.map((type) => [type, state])) },
        });
      }
      if (closeAfterState) close();
    }).catch(close);
  };
  for (const socket of sockets) {
    socket.addEventListener("message", (event) => {
      if (event.data === MAILBOX_REALTIME_UPDATE) onUpdate();
    });
    socket.addEventListener("close", close);
    socket.addEventListener("error", close);
  }
  if (ping) timer = setInterval(() => void send("ping", { interval: ping }), ping * 1000);
  input.signal.addEventListener("abort", close);

  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-store",
      "x-accel-buffering": "no",
    },
  });
}
