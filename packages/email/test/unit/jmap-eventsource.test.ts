import { describe, expect, it, mock } from "bun:test";

import type { JmapAccount } from "../../worker/jmap/methods.ts";

// The stream opens no mailbox sockets here; the Durable Object module needs the Workers runtime.
mock.module("../../worker/mailbox/index.ts", () => ({
  mailboxStub: () => {
    throw new Error("No mailboxes in this test");
  },
}));

mock.module("../../worker/jmap/push.ts", () => ({
  JMAP_PUSH_TYPES: ["Email", "Mailbox"],
  stateChange: (changed: Record<string, string>) => changed,
}));

const { jmapEventStream } = await import("../../worker/jmap/eventsource.ts");

const account = (id: string): JmapAccount => ({
  id,
  address: `${id}@example.test`,
  displayName: id,
  ownerUserId: null,
  isPrimary: false,
  canSend: true,
  isPersonal: false,
});

/** A stream over `accounts` that re-checks every few milliseconds; its text until it closes. */
async function run(
  accounts: JmapAccount[],
  now: () => JmapAccount[],
  authorized = () => true
) {
  const pending: Promise<unknown>[] = [];

  const response = await jmapEventStream({
    // SAFETY: with no push types the stream opens no mailbox sockets, the only thing that reads env (mailboxStub is mocked to throw if it is ever reached).
    env: {} as Env,
    accounts,
    // No push types: the stream opens no mailbox sockets, only checks and keep-alives.
    types: "Calendar",
    closeAfterState: false,
    pingSeconds: 0,
    stillAuthorized: () => Promise.resolve(authorized()),
    currentAccounts: () => Promise.resolve(now()),
    defer: (task) => pending.push(task),
    checkEveryMs: 5,
  });

  return Promise.race([
    response.text(),
    new Promise<string>((resolve) => {
      setTimeout(() => resolve("still open"), 200);
    }),
  ]);
}

describe("the JMAP event stream", () => {
  it("stays open while the person's accounts are the same", async () => {
    expect(
      await run([account("a"), account("b")], () => [
        account("b"),
        account("a"),
      ])
    ).toBe("still open");
  });

  it("closes when an account is added or taken away", async () => {
    expect(
      await run([account("a"), account("b")], () => [account("a")])
    ).toContain(": connected");
    expect(
      await run([account("a")], () => [account("a"), account("c")])
    ).toContain(": connected");
  });

  it("closes when the token stops working", async () => {
    expect(
      await run(
        [account("a")],
        () => [account("a")],
        () => false
      )
    ).toContain(": connected");
  });
});
