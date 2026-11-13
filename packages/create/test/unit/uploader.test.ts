import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ImportItem } from "../../import/protocol.ts";
import { ResumeState, upload } from "../../import/uploader.ts";
import type { ImportDestination } from "../../import/uploader.ts";
import { WorkspaceError } from "../../import/workspace.ts";

function item(id: string): ImportItem {
  return {
    sourceId: id,
    raw: new TextEncoder().encode(`Subject: ${id}\r\n\r\nx`),
    placement: "inbox",
  };
}

async function* items(ids: string[]) {
  for (const id of ids) yield item(id);
}

/** A workspace that fails as told and records what it was sent. */
function fakeWorkspace(
  behaviour: (id: string, attempt: number) => "ok" | "duplicate" | Error
) {
  const attempts = new Map<string, number>();
  const sent: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const finished: string[] = [];

  const workspace: ImportDestination = {
    async importMessage(mailboxId: string, value: ImportItem) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Bun.sleep(2);
      inFlight -= 1;
      const attempt = (attempts.get(value.sourceId) ?? 0) + 1;
      attempts.set(value.sourceId, attempt);
      const outcome = behaviour(value.sourceId, attempt);

      if (outcome instanceof Error) throw outcome;
      sent.push(value.sourceId);

      return outcome === "duplicate"
        ? {
            status: "duplicate" as const,
            id: `msg_${value.sourceId}`,
            conversationId: "c",
          }
        : {
            status: "imported" as const,
            id: `msg_${value.sourceId}`,
            conversationId: "c",
            folderSkipped: null,
          };
    },
    finishImport(mailboxId: string) {
      finished.push(mailboxId);

      return Promise.resolve({ version: 1 });
    },
  };

  return {
    workspace,
    sent,
    finished,
    attempts,
    maxInFlight: () => maxInFlight,
  };
}

const stateDir = () => mkdtempSync(join(tmpdir(), "ow-import-"));

describe("upload", () => {
  it("bounds concurrency, retries transient failures, records failures, and resumes", async () => {
    const dir = stateDir();

    const fake = fakeWorkspace((id, attempt) => {
      if (id === "flaky" && attempt < 3) return new WorkspaceError(503, "busy");

      if (id === "broken") {
        return new WorkspaceError(422, "The message could not be read");
      }

      if (id === "dup") return "duplicate";

      return "ok";
    });

    const ids = ["a", "b", "flaky", "broken", "dup", "c", "d"];

    const stats = await upload({
      workspace: fake.workspace,
      mailboxId: "mbx_1",
      items: items(ids),
      state: new ResumeState(dir, "job"),
      concurrency: 2,
      backoff: () => 1,
    });

    expect(stats).toMatchObject({
      imported: 5,
      duplicate: 1,
      failed: 1,
      resumed: 0,
    });
    expect(fake.maxInFlight()).toBe(2);
    expect(fake.attempts.get("flaky")).toBe(3);
    expect(fake.finished).toEqual(["mbx_1"]);

    // A second run sends only what did not land.
    const again = fakeWorkspace(() => "ok");

    const resumed = await upload({
      workspace: again.workspace,
      mailboxId: "mbx_1",
      items: items(ids),
      state: new ResumeState(dir, "job"),
      concurrency: 2,
      backoff: () => 1,
    });

    expect(again.sent).toEqual(["broken"]);
    expect(resumed).toMatchObject({ imported: 1, resumed: 6 });
  });

  it("stops at a refusal that would fail every message", async () => {
    const fake = fakeWorkspace(
      () => new WorkspaceError(403, "You may not import mail into this mailbox")
    );

    await expect(
      upload({
        workspace: fake.workspace,
        mailboxId: "mbx_1",
        items: items(["a", "b", "c"]),
        state: new ResumeState(stateDir(), "job"),
        concurrency: 1,
      })
    ).rejects.toThrow("You may not import mail into this mailbox");
    expect(fake.finished).toEqual([]);
  });
});
