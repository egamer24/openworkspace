import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { invariant, required } from "../../import/invariant.ts";
import { mboxFiles, mboxItems, scanMbox } from "../../import/mbox-source.ts";
import type { MboxSourceOptions } from "../../import/mbox-source.ts";
import { fromLineDate, readMbox } from "../../import/mbox.ts";
import type { ImportItem, SkippedItem } from "../../import/protocol.ts";

const fixture = join(import.meta.dirname, "../fixtures/takeout.mbox");
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/**
 * A stream that hands the bytes over in chunks of `size`, splitting lines anywhere.
 * @yields {Uint8Array} The next chunk.
 */
async function* chunked(value: string, size: number) {
  const bytes = new TextEncoder().encode(value);

  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.slice(offset, offset + size);
  }
}

async function all<T>(items: AsyncIterable<T>) {
  const out: T[] = [];

  for await (const item of items) out.push(item);

  return out;
}

/** An item the test expects to be imported, not skipped. */
function imported(item: ImportItem | SkippedItem | undefined): ImportItem {
  const value = required(item, "expected another item");
  invariant(!("skipped" in value), `${value.sourceId} was skipped`);

  return value;
}

const options: MboxSourceOptions = {
  archivedLabels: "archive",
  folderPriority: [],
  skip: new Set(),
  placement: "archive",
  folder: null,
};

describe("mbox reader", () => {
  const mbox = [
    "From alice@example.test Mon Mar  2 10:00:00 2026",
    "Subject: one",
    "",
    "line",
    ">From escaped",
    ">>From twice",
    "From not a separator (no empty line before)",
    "",
    "From bob@example.test Tue Mar 03 09:15:00 +0100 2026",
    "Subject: two",
    "",
    "body",
    "",
  ].join("\n");

  for (const size of [1, 7, 64, 100_000]) {
    it(`splits messages and unescapes From lines (chunks of ${size})`, async () => {
      const messages = await all(
        readMbox(chunked(mbox, size), { maxBytes: 1000 })
      );

      expect(messages.map((message) => message.fromLine)).toEqual([
        "From alice@example.test Mon Mar  2 10:00:00 2026",
        "From bob@example.test Tue Mar 03 09:15:00 +0100 2026",
      ]);
      const [first, second] = messages;
      expect(text(required(first, "first message").raw)).toBe(
        "Subject: one\n\nline\nFrom escaped\n>From twice\nFrom not a separator (no empty line before)\n"
      );
      expect(text(required(second, "second message").raw)).toBe(
        "Subject: two\n\nbody\n"
      );
    });
  }

  it("counts but does not keep messages over the limit", async () => {
    const big = `From a@example.test Mon Mar  2 10:00:00 2026\nSubject: big\n\n${"x".repeat(5000)}\n\nFrom b@example.test Mon Mar  2 10:00:00 2026\nSubject: small\n\nok\n`;

    const [first, second] = await all(
      readMbox(chunked(big, 512), { maxBytes: 1000 })
    );

    expect(first).toMatchObject({ tooLarge: true, raw: new Uint8Array(0) });
    expect(required(first, "first message").size).toBeGreaterThan(5000);
    expect(second).toMatchObject({ tooLarge: false, index: 1 });
  });

  it("reads the date on the From line", () => {
    expect(fromLineDate("From 1810@xxx Tue Mar 03 09:15:00 +0100 2026")).toBe(
      Date.UTC(2026, 2, 3, 8, 15)
    );
    expect(fromLineDate("From MAILER-DAEMON Mon Mar  2 10:00:00 2026")).toBe(
      Date.UTC(2026, 2, 2, 10)
    );
    expect(fromLineDate("From someone")).toBeUndefined();
  });
});

describe("Takeout mbox", () => {
  it("maps labels, read state, threads and direction", async () => {
    const files = mboxFiles([join(import.meta.dirname, "../fixtures")]);
    expect(files).toEqual([fixture]);
    const scan = await scanMbox(files, options);
    expect(scan.count).toBe(6);
    const items = await all(mboxItems(files, options, scan.threads));

    const [first, reply, receipt, spam, trash, draft] = items;
    const kiln = imported(first);

    expect(kiln).toMatchObject({
      placement: "inbox",
      folder: "Clients",
      seen: true,
      thread: "gmail:1810000000000000001",
      direction: "incoming",
      receivedAt: Date.UTC(2026, 2, 3, 9, 15),
    });
    expect(kiln.sourceId).toMatch(/^mbox:[0-9a-f]{64}$/u);
    expect(text(kiln.raw)).toContain("\r\nFrom the studio log");
    // Sent alone has no say over the conversation, which the Inbox message places.
    expect(reply).toMatchObject({
      placement: "sent",
      folder: null,
      direction: "outgoing",
      thread: kiln.thread,
    });
    // Labels outside the Inbox: Archive by default, quoted and encoded names decoded.
    expect(receipt).toMatchObject({
      placement: "archive",
      folder: null,
      seen: false,
    });
    expect(spam).toMatchObject({ placement: "spam", seen: false });
    expect(trash).toMatchObject({ placement: "trash", seen: true });
    expect(draft).toMatchObject({ skipped: "draft" });

    const asFolders = {
      ...options,
      archivedLabels: "folder" as const,
      folderPriority: ["café"],
      skip: new Set(["spam", "trash"] as const),
    };

    const again = await all(
      mboxItems(files, asFolders, (await scanMbox(files, asFolders)).threads)
    );

    expect(again[2]).toMatchObject({ placement: "inbox", folder: "Café" });
    expect(again[3]).toMatchObject({ skipped: "spam" });
    expect(again[4]).toMatchObject({ skipped: "trash" });
    // The same bytes, the same source id: a re-run is recognized.
    expect(imported(again[0]).sourceId).toBe(kiln.sourceId);
  });

  it("gives plain mbox mail one place, Status read state and header threads", async () => {
    const mbox = [
      "From a@example.test Mon Mar  2 10:00:00 2026",
      "Message-ID: <root@example.test>",
      "Status: RO",
      "",
      "first",
      "",
      "From b@example.test Mon Mar  2 11:00:00 2026",
      "Message-ID: <child@example.test>",
      "In-Reply-To: <root@example.test>",
      "References: <root@example.test>",
      "Status: O",
      "",
      "second",
      "",
    ].join("\n");

    const path = join(
      process.env.TMPDIR ?? "/tmp",
      `plain-${crypto.randomUUID()}.mbox`
    );

    await Bun.write(path, mbox);
    const scan = await scanMbox([path], options);

    const items = (
      await all(
        mboxItems(
          [path],
          { ...options, placement: "inbox", folder: "Old mail" },
          scan.threads
        )
      )
    ).map(imported);

    expect(
      items.map((item) => [
        item.placement,
        item.folder,
        item.seen,
        item.thread,
        item.direction,
      ])
    ).toEqual([
      ["inbox", "Old mail", true, "mid:root@example.test", undefined],
      ["inbox", "Old mail", false, "mid:root@example.test", undefined],
    ]);
  });
});
