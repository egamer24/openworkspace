import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { required } from "@open-workspace/core/shared";
import { main } from "@open-workspace/create/import/cli.ts";
import { z } from "zod";

import { readJson } from "./json.ts";
import { bootstrapAdmin } from "./mail-flow-helpers.ts";
import { env, hooks, useFreshWorkspace, worker } from "./workspace.ts";

useFreshWorkspace();

/**
 * The `import` CLI end to end against the stack: it signs in through the
 * browser flow (the "browser" here approves consent as the administrator
 * and follows the redirect to the CLI's loopback server), reads the
 * synthetic Takeout fixture, and uploads it.
 */

const origin = "http://example.test";

const fixture = join(
  import.meta.dirname,
  "../../../create/test/fixtures/takeout.mbox"
);

let cookie = "";
let mailboxId = "";

function deps(log: string[]) {
  return {
    fetch: (input: string, init?: RequestInit) =>
      worker.fetch(new Request(input, init)),
    credentialsPath: null,
    log: (line: string) => log.push(line),
    progress: () => {},
    async openBrowser(url: string) {
      const authorize = await worker.fetch(
        new Request(url, { headers: { cookie }, redirect: "manual" })
      );

      const [, consent] = required(
        required(
          authorize.headers.get("location"),
          "authorize redirects"
        ).match(/\/oidc\/consent\/([^/?#]+)/u),
        "authorize redirects to the consent screen"
      );

      const approved = await worker.fetch(
        new Request(`${origin}/api/oidc/consent/${consent}`, {
          method: "POST",
          headers: { cookie, origin, "content-type": "application/json" },
          body: JSON.stringify({ approved: true }),
        })
      );

      const { redirectTo } = await readJson(
        approved,
        z.object({ redirectTo: z.string() })
      );

      // The loopback callback is the CLI's own server, on this machine.
      await (await fetch(redirectTo)).text();
    },
  };
}

beforeAll(async () => {
  cookie = await bootstrapAdmin("ada@example.test", "Ada Moss");
  mailboxId = required(
    await env.DB.prepare(
      "SELECT id FROM mailboxes WHERE local_part = 'ada'"
    ).first<{ id: string }>(),
    "bootstrap made Ada's mailbox"
  ).id;
});

describe("import CLI", () => {
  it("signs in, imports a Takeout mbox, and resumes without sending it again", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ow-import-e2e-"));

    const args = [
      "mbox",
      fixture,
      "--workspace",
      origin,
      "--into",
      "ada@example.test",
      "--state-dir",
      stateDir,
    ];

    const log: string[] = [];
    expect(await main(args, deps(log)), log.join("\n")).toBe(0);
    expect(log.join("\n")).toContain("5 imported");
    expect(log.join("\n")).toContain("1 skipped");

    const rows = await hooks.mailboxSql(
      mailboxId,
      `
      SELECT e.subject, e.direction, c.mailbox_state, f.name AS folder,
        exists(SELECT 1 FROM email_read_states r WHERE r.email_id = e.id) AS seen
      FROM emails e JOIN conversations c ON c.id = e.conversation_id LEFT JOIN folders f ON f.id = c.folder_id
      ORDER BY e.timeline_at`
    );

    expect(rows).toEqual([
      {
        subject: "Kiln schedule for April",
        direction: "incoming",
        mailbox_state: "active",
        folder: "Clients",
        seen: 1,
      },
      {
        subject: "Re: Kiln schedule for April",
        direction: "outgoing",
        mailbox_state: "active",
        folder: "Clients",
        seen: 0,
      },
      {
        subject: "Your receipt",
        direction: "incoming",
        mailbox_state: "archive",
        folder: null,
        seen: 0,
      },
      {
        subject: "You won a tractor",
        direction: "incoming",
        mailbox_state: "spam",
        folder: null,
        seen: 0,
      },
      {
        subject: "Quarry weekly #12",
        direction: "incoming",
        mailbox_state: "trash",
        folder: null,
        seen: 1,
      },
    ]);

    // The CLI finished the batch: D1 has the counts (one unread-or-not inbox message, read).
    const counts = await env.DB.prepare(
      "SELECT incoming_count FROM mailbox_counts WHERE mailbox_id = ?"
    )
      .bind(mailboxId)
      .first<{ incoming_count: number }>();

    expect(counts).toEqual({ incoming_count: 1 });

    // Resuming skips everything already imported, with a token given outright.
    const token = await signedInToken();
    const resumedLog: string[] = [];
    expect(await main([...args, "--token", token], deps(resumedLog))).toBe(0);
    expect(resumedLog.join("\n")).toContain("0 imported, 5 done before");

    // Without the local state, the workspace still imports nothing twice.
    const freshLog: string[] = [];
    const fresh = mkdtempSync(join(tmpdir(), "ow-import-e2e-"));
    expect(
      await main(
        [
          "mbox",
          fixture,
          "--workspace",
          origin,
          "--into",
          mailboxId,
          "--state-dir",
          fresh,
          "--token",
          token,
        ],
        deps(freshLog)
      )
    ).toBe(0);
    expect(freshLog.join("\n")).toContain("0 imported, 5 already there");

    const [row] = await hooks.mailboxRows(
      mailboxId,
      z.object({ count: z.number() }),
      "SELECT count(*) AS count FROM emails"
    );

    expect(row?.count).toBe(5);
  });

  it("says where it may import when the target is not allowed", async () => {
    const log: string[] = [];
    const errors: string[] = [];
    const { error } = console;
    console.error = (line: string) => errors.push(line);

    try {
      expect(
        await main(
          [
            "mbox",
            fixture,
            "--workspace",
            origin,
            "--into",
            "nobody@example.test",
            "--token",
            await signedInToken(),
          ],
          deps(log)
        )
      ).toBe(1);
    } finally {
      console.error = error;
    }

    expect(errors.join("\n")).toContain(
      "You may not import into nobody@example.test"
    );
    expect(errors.join("\n")).toContain("ada@example.test");
  });
});

/** An access token from the CLI's own sign-in, for runs that pass --token. */
async function signedInToken() {
  const { OAuthSession } =
    await import("@open-workspace/create/import/oauth.ts");

  const session = await OAuthSession.login({
    workspace: origin,
    scopes: ["mail.organize", "admin.import_mail"],
    ...deps([]),
  });

  return session.token();
}
