import { z } from "zod";

import { mailboxStub } from "../mailbox";
import type { JmapAccount } from "./methods";
import { stateChange } from "./push";
import { wantsMailChanges } from "./push-types";
import type { StateChange } from "./push-types";

/** How often a stream re-checks its token and accounts when the client asked for no pings. */
const AUTHORIZATION_CHECK_SECONDS = 300;
const MIN_PING_SECONDS = 30;

/** A mailbox sends its new JMAP state, a counter, as a text message. */
const mailboxStateMessage = z.string();

/** RFC 8620 §7.3: the ping a stream sends at the interval the client asked for. */
type Ping = { "@type": "Ping"; interval: number };

/**
 * An RFC 8620 §7.3 event stream: a `state` event whenever one of the
 * accounts' mailboxes changes, and `ping` events at the asked interval.
 * Each mailbox Durable Object sends its new state over a WebSocket the
 * stream holds open.
 */
export async function jmapEventStream(input: {
  env: Env;
  accounts: JmapAccount[];
  /** `*` or a comma-separated list of data types. */
  types: string;
  closeAfterState: boolean;
  pingSeconds: number;
  stillAuthorized: () => Promise<boolean>;
  /**
   * The accounts the person can open now. The stream holds a socket per
   * account it started with, so when the set changes (a mailbox shared or
   * taken away) it closes and the client reconnects with the new set.
   */
  currentAccounts: () => Promise<JmapAccount[]>;
  defer: (task: Promise<unknown>) => void;
  /** How often to re-check; tests shorten it. Defaults to the ping interval, or five minutes. */
  checkEveryMs?: number;
}) {
  const wanted =
    input.types === "*"
      ? null
      : input.types.split(",").map((type) => type.trim());

  const interested = wantsMailChanges(wanted);

  const pingSeconds =
    Number.isFinite(input.pingSeconds) && input.pingSeconds > 0
      ? Math.max(MIN_PING_SECONDS, Math.floor(input.pingSeconds))
      : 0;

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const sockets: WebSocket[] = [];
  // oxlint-disable-next-line prefer-const -- assigned after the close handler that clears it is defined
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let finished!: () => void;
  input.defer(
    new Promise<void>((resolve) => {
      finished = resolve;
    })
  );

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
    finished();
  };

  const write = (text: string) => {
    if (closed) return;
    // A write fails once the client has gone; that ends the stream.
    writer.write(encoder.encode(text)).catch(close);
  };

  const event = (name: "state" | "ping", data: StateChange | Ping) =>
    write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);

  if (interested) {
    const responses = await Promise.all(
      input.accounts.map(async (account) => ({
        account,
        response: await mailboxStub(input.env, account.id).fetch(
          new Request("https://mailbox.internal/jmap", {
            headers: { upgrade: "websocket", "x-openworkspace-jmap": "1" },
          })
        ),
      }))
    );

    for (const { account, response } of responses) {
      const socket = response.webSocket;

      if (!socket) continue;
      socket.accept();
      sockets.push(socket);
      socket.addEventListener("message", (message) => {
        const state = mailboxStateMessage.safeParse(message.data);

        if (!state.success) return;
        event("state", stateChange({ [account.id]: state.data }));

        if (input.closeAfterState) close();
      });
      // A mailbox that goes away (deleted, or the object restarted) ends the
      // stream; the client reconnects and gets a fresh set of accounts.
      socket.addEventListener("close", close);
      socket.addEventListener("error", close);
    }
  }

  const accountIds = (accounts: JmapAccount[]) =>
    accounts
      .map((account) => account.id)
      .sort()
      .join("\0");

  const startedWith = accountIds(input.accounts);

  const tick = async () => {
    if (!(await input.stillAuthorized().catch(() => false))) {
      close();

      return;
    }

    const now = await input.currentAccounts().catch(() => null);

    if (!now || accountIds(now) !== startedWith) {
      close();

      return;
    }

    if (pingSeconds) event("ping", { "@type": "Ping", interval: pingSeconds });
    else write(": keep-alive\n\n");
  };

  timer = setInterval(
    () => void tick(),
    input.checkEveryMs ?? (pingSeconds || AUTHORIZATION_CHECK_SECONDS) * 1000
  );
  // Flush the headers to the client straight away.
  write(": connected\n\n");

  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
