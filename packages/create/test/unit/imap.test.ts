import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-expect-error hoodiecrow ships no types
import hoodiecrow from "hoodiecrow-imap";
import { ImapFlow } from "imapflow";
import { z } from "zod";

import { main } from "../../import/cli.ts";
import { folderPlans, imapSource } from "../../import/imap-source.ts";
import { invariant, required } from "../../import/invariant.ts";
import type { ImportItem, SkippedItem } from "../../import/protocol.ts";
import { ResumeState, upload } from "../../import/uploader.ts";
import type { ImportDestination } from "../../import/uploader.ts";

/**
 * The IMAP source against Hoodiecrow, a scriptable IMAP server that runs
 * in this process: Gmail's extensions (X-GM-EXT-1) on one server, plain
 * special-use folders on another. Made-up people and domains only.
 */

const message = (id: string, subject: string, extra = "") =>
  `From: Juniper Vale <juniper@tidewell.example>\r\nTo: ada@example.test\r\nSubject: ${subject}\r\nMessage-ID: <${id}@tidewell.example>\r\n${extra}\r\n${subject} body\r\n`;

const servers: { close: (done: () => void) => void }[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(resolve);
        })
    )
  );
});

/** A Hoodiecrow folder: its messages, flags and special use, and the folders in it. */
type StoredFolder = {
  separator?: string;
  flags?: string[];
  "special-use"?: string;
  messages?: {
    raw: string;
    flags: string[];
    internaldate?: string;
    "X-GM-LABELS"?: string[];
    "X-GM-THRID"?: string;
  }[];
  folders?: Record<string, StoredFolder>;
};

type ServerOptions = {
  plugins: string[];
  storage: Record<string, StoredFolder>;
};

/** Where the server listens (net.Server#address() once listening on a port). */
const addressSchema = z.object({ port: z.number() });

async function serve(options: ServerOptions) {
  const server = hoodiecrow(options);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);

  return addressSchema.parse(server.server.address()).port;
}

type Auth = { user: string; pass?: string; accessToken?: string };

const PASSWORD: Auth = { user: "testuser", pass: "testpass" };

async function client(port: number, auth: Auth) {
  const imap = new ImapFlow({
    host: "127.0.0.1",
    port,
    secure: false,
    auth,
    logger: false,
  });

  await imap.connect();

  return imap;
}

async function all(items: AsyncIterable<ImportItem | SkippedItem>) {
  const out: (ImportItem | SkippedItem)[] = [];

  for await (const item of items) out.push(item);

  return out;
}

/** An item the test expects to be imported, not skipped. */
function imported(item: ImportItem | SkippedItem | undefined): ImportItem {
  const value = required(item, "expected another item");
  invariant(!("skipped" in value), `${value.sourceId} was skipped`);

  return value;
}

const gmailStorage = {
  INBOX: { messages: [] },
  "": {
    separator: "/",
    folders: {
      "[Gmail]": {
        flags: ["\\Noselect"],
        folders: {
          "All Mail": {
            "special-use": "\\All",
            messages: [
              {
                raw: message("kiln-1", "Kiln schedule"),
                flags: ["\\Seen"],
                internaldate: "03-Mar-2026 09:15:00 +0000",
                "X-GM-LABELS": ["\\Inbox", "Clients"],
                "X-GM-THRID": "1810000000000000001",
              },
              {
                raw: message(
                  "kiln-2",
                  "Re: Kiln schedule",
                  "In-Reply-To: <kiln-1@tidewell.example>\r\n"
                ),
                flags: ["\\Seen"],
                "X-GM-LABELS": ["\\Sent"],
                "X-GM-THRID": "1810000000000000001",
              },
              {
                raw: message("receipt-3", "Receipt"),
                flags: [],
                "X-GM-LABELS": ["Receipts"],
                "X-GM-THRID": "1810000000000000003",
              },
              {
                raw: message("draft-4", "Draft"),
                flags: ["\\Draft"],
                "X-GM-LABELS": ["\\Draft"],
                "X-GM-THRID": "1810000000000000004",
              },
            ],
          },
          "Sent Mail": { "special-use": "\\Sent", messages: [] },
          Drafts: { "special-use": "\\Drafts" },
          Spam: { "special-use": "\\Junk" },
          Trash: { "special-use": "\\Trash" },
        },
      },
      Clients: {},
      Receipts: {},
    },
  },
} satisfies Record<string, StoredFolder>;

describe("IMAP source", () => {
  for (const [method, auth] of [
    ["an app password", PASSWORD],
    ["XOAUTH2", { user: "testuser", accessToken: "testtoken" }],
  ] as const) {
    it(`reads Gmail's All Mail with labels and threads, with ${method}`, async () => {
      const port = await serve({
        plugins: ["SPECIAL-USE", "X-GM-EXT-1", "SASL-IR", "XOAUTH2", "IDLE"],
        storage: gmailStorage,
      });

      const imap = await client(port, auth);

      try {
        const source = await imapSource(imap, {
          archivedLabels: "archive",
          folderPriority: [],
          skip: new Set(),
          account: "imap.gmail.example/ada",
          done: () => false,
        });

        expect(source).toMatchObject({ gmail: true, total: 4 });

        const items = await all(source.items);

        expect(items.map((item) => item.sourceId)).toEqual(
          items.map(() => expect.stringMatching(/^gmail:\d+$/u))
        );
        expect(items[0]).toMatchObject({
          placement: "inbox",
          folder: "Clients",
          seen: true,
          thread: "gmail:1810000000000000001",
          direction: "incoming",
          receivedAt: Date.UTC(2026, 2, 3, 9, 15),
        });
        expect(new TextDecoder().decode(imported(items[0]).raw)).toContain(
          "Subject: Kiln schedule"
        );
        expect(items[1]).toMatchObject({
          placement: "sent",
          direction: "outgoing",
          thread: "gmail:1810000000000000001",
        });
        expect(items[2]).toMatchObject({
          placement: "archive",
          folder: null,
          seen: false,
        });
        expect(items[3]).toMatchObject({ skipped: "draft" });
      } finally {
        await imap.logout();
      }
    });
  }

  it("walks other servers' folders by special use, and resumes without downloading again", async () => {
    const port = await serve({
      plugins: ["SPECIAL-USE"],
      storage: {
        INBOX: { messages: [{ raw: message("a", "In the inbox"), flags: [] }] },
        "": {
          separator: ".",
          folders: {
            Sent: {
              "special-use": "\\Sent",
              messages: [
                {
                  raw: message(
                    "b",
                    "Re: In the inbox",
                    "References: <a@tidewell.example>\r\n"
                  ),
                  flags: ["\\Seen"],
                },
              ],
            },
            Junk: {
              "special-use": "\\Junk",
              messages: [{ raw: message("c", "Win"), flags: [] }],
            },
            Drafts: {
              "special-use": "\\Drafts",
              messages: [{ raw: message("d", "Draft"), flags: [] }],
            },
            Projects: {
              folders: {
                Kilns: {
                  messages: [
                    { raw: message("e", "Kiln plans"), flags: ["\\Seen"] },
                  ],
                },
              },
            },
          },
        },
      },
    });

    const imap = await client(port, PASSWORD);
    const dir = mkdtempSync(join(tmpdir(), "ow-imap-"));

    try {
      const options = (done: (id: string) => boolean) => ({
        archivedLabels: "folder" as const,
        folderPriority: [],
        skip: new Set(["spam"] as const),
        account: "mail.example/ada",
        done,
      });

      const source = await imapSource(
        imap,
        options(() => false)
      );

      expect(source).toMatchObject({ gmail: false, total: 3 });
      const items = (await all(source.items)).map(imported);
      expect(
        items.map((item) => [
          item.placement,
          item.folder,
          item.seen,
          item.thread,
          item.direction,
        ])
      ).toEqual([
        ["inbox", null, false, "mid:a@tidewell.example", undefined],
        ["sent", null, true, "mid:a@tidewell.example", "outgoing"],
        ["inbox", "Projects/Kilns", true, "mid:e@tidewell.example", undefined],
      ]);
      expect(imported(items[0]).sourceId).toMatch(
        /^imap:mail\.example\/ada\/INBOX\/\d+\/1$/u
      );

      // Upload, then run again: nothing is downloaded or sent twice.
      const sent: string[] = [];

      const workspace: ImportDestination = {
        importMessage(_mailbox: string, item: ImportItem) {
          sent.push(item.sourceId);

          return Promise.resolve({
            status: "imported" as const,
            id: "x",
            conversationId: "c",
            folderSkipped: null,
          });
        },
        finishImport() {
          return Promise.resolve({ version: 1 });
        },
      };

      await upload({
        workspace,
        mailboxId: "mbx",
        items,
        state: new ResumeState(dir, "job"),
        concurrency: 2,
      });
      expect(sent).toHaveLength(3);
      const state = new ResumeState(dir, "job");

      const again = await imapSource(
        imap,
        options((id) => state.has(id))
      );

      const second = await all(again.items);
      expect(
        second.every((item) => "skipped" in item && item.skipped === "done")
      ).toBe(true);
    } finally {
      await imap.logout();
    }
  });

  it("runs as the imap command with --dry-run", async () => {
    const port = await serve({
      plugins: ["SPECIAL-USE", "X-GM-EXT-1"],
      storage: gmailStorage,
    });

    const log: string[] = [];

    const code = await main(
      [
        "imap",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--plain",
        "--user",
        "testuser",
        "--password",
        "testpass",
        "--into",
        "ada@example.test",
        "--dry-run",
      ],
      { log: (line) => log.push(line) }
    );

    expect(code).toBe(0);
    expect(log).toEqual([
      "testuser: 4 messages in All Mail (Gmail)",
      "testuser → ada@example.test: 4 messages",
      "  places: inbox 1, sent 1, archive 1",
      "  folders: Clients 1",
      "  unread: 1",
      "  skipped: draft 1",
    ]);
  });

  it("plans folders by special use", () => {
    const flags = (...values: string[]) => new Set(values);
    expect(
      folderPlans(
        [
          { path: "INBOX", delimiter: "/", flags: flags() },
          {
            path: "Archive",
            delimiter: "/",
            flags: flags(),
            specialUse: "\\Archive",
          },
          {
            path: "Trash",
            delimiter: "/",
            flags: flags(),
            specialUse: "\\Trash",
          },
          { path: "All", delimiter: "/", flags: flags(), specialUse: "\\All" },
          { path: "INBOX.Work", delimiter: ".", flags: flags() },
          { path: "Parent", delimiter: "/", flags: flags("\\Noselect") },
        ],
        { archivedLabels: "archive" }
      )
    ).toEqual([
      { path: "INBOX", placement: "inbox", folder: null },
      { path: "Archive", placement: "archive", folder: null },
      { path: "Trash", placement: "trash", folder: null },
      { path: "INBOX.Work", placement: "archive", folder: null },
    ]);
  });
});
