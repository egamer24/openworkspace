import { expect } from "bun:test";

import { required } from "@open-workspace/core/shared";
import { z } from "zod";

import type { UploadCall } from "./hooks/mail-flow.ts";
import { pollUntil } from "./poll.ts";
import { hooks, worker } from "./workspace.ts";

/** Signs up the first administrator; their session cookie. */
export async function bootstrapAdmin(
  email = "admin@example.test",
  name = "Admin"
) {
  const response = await worker.fetch(
    "http://example.test/api/auth/mock/bootstrap",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, email }),
    }
  );

  expect(response.status).toBe(200);
  await response.json();

  const [cookie] = required(
    response.headers.get("set-cookie"),
    "bootstrap sets a session cookie"
  ).split(";", 1);

  return required(cookie, "the Set-Cookie header starts with name=value");
}

const mailboxList = z.object({
  mailboxes: z.array(z.looseObject({ id: z.string() })),
});

/** The id of the first mailbox the session's person has (an admin's own, after bootstrap). */
export async function firstMailboxId(cookie: string) {
  const response = await worker.fetch(
    new Request("http://example.test/api/mail/mailboxes", {
      headers: { cookie },
    })
  );

  const [mailbox] = mailboxList.parse(await response.json()).mailboxes;

  return required(mailbox, "the person has a mailbox").id;
}

/**
 * Processes a mailbox's queued inbound mail now. Each alarm takes one
 * delivery; the stack's own alarms may run some first, so this waits until
 * none is pending rather than counting wakes.
 */
export async function drainInbound(mailboxId: string, timeoutMs = 10_000) {
  await pollUntil(
    async () => {
      await hooks.runAlarm(mailboxId);

      const [row] = await hooks.mailboxRows(
        mailboxId,
        z.object({ pending: z.number() }),
        "SELECT count(*) AS pending FROM pending_inbound WHERE next_attempt_at <= ?",
        Date.now()
      );

      return required(row, "count(*) gives a row").pending === 0;
    },
    {
      timeoutMs,
      intervalMs: 25,
      failure: `Inbound mail for ${mailboxId} is still pending`,
    }
  );
}

type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: { name: string; message: string } };

/** A worker function's result, or its error rethrown here with the same class name and message. */
export function unwrap<T>(result: Outcome<T>): T {
  if (result.ok) return result.value;
  throw Object.assign(new Error(result.error.message), {
    name: result.error.name,
  });
}

/** One function of the email module's uploads.ts, run in the Worker (hooks/mail-flow.ts). */
export async function uploads<T = unknown>(call: UploadCall): Promise<T> {
  return unwrap(await hooks.call<Outcome<T>>("mailFlow.uploads", call));
}
