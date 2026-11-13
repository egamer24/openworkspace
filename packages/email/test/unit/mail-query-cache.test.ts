import { describe, expect, it } from "bun:test";

import { required } from "@open-workspace/core/shared";
import {
  applyOwnReadChange,
  noteMailboxVersion,
} from "@open-workspace/email/src/mail/mail-query-cache.ts";
import { QueryClient } from "@tanstack/react-query";
import { z } from "zod";

const reader = { userId: "usr_me", name: "Me" };

/** The cache entries these tests read back; loose, so every field stays for the matchers. */
const entry = z.looseObject({});
const pagedSchema = z.object({ pages: z.array(entry) });

const conversationSchema = z.object({
  pages: z.array(z.looseObject({ messages: z.array(entry) })),
});

const foldersSchema = z.looseObject({
  version: z.number(),
  folders: z.array(entry),
});

const mailboxesSchema = z.looseObject({ mailboxes: z.array(entry) });

function cached<Schema extends z.ZodType>(
  client: QueryClient,
  key: readonly (string | boolean)[],
  schema: Schema
): z.output<Schema> {
  return schema.parse(client.getQueryData(key));
}

function page<T extends object>(version: number, value: T) {
  return { pages: [{ version, ...value }], pageParams: [undefined] };
}

/** A cache as the reader leaves it: inbox list, folders, mailboxes and one open conversation, all at `version`. */
function seeded(version: number) {
  const client = new QueryClient();
  client.setQueryData(["mailboxes"], {
    ok: true,
    mailboxes: [
      { id: "mbx", unreadCount: 3, version },
      { id: "mbx_other", unreadCount: 7, version: 40 },
    ],
  });
  client.setQueryData(["folders", "mbx"], {
    ok: true,
    version,
    folders: [
      {
        id: "inbox",
        kind: "system",
        systemType: "inbox",
        unreadCount: 3,
        totalCount: 9,
      },
      {
        id: "project",
        kind: "custom",
        systemType: null,
        unreadCount: 2,
        totalCount: 4,
      },
      {
        id: "archive",
        kind: "system",
        systemType: "archive",
        unreadCount: 1,
        totalCount: 1,
      },
    ],
  });
  client.setQueryData(
    ["conversations", "mbx", "inbox", "", false],
    page(version, {
      conversations: [
        { conversationId: "conv", unreadCount: 2, isUnread: true },
        { conversationId: "conv_other", unreadCount: 1, isUnread: true },
      ],
    })
  );
  client.setQueryData(
    ["conversation", "mbx", "conv"],
    page(version, {
      mailboxState: "active",
      folderId: "project",
      hasIncoming: true,
      hasOutgoing: false,
      unreadCount: 2,
      messages: [
        { id: "msg_1", direction: "incoming", isRead: false, viewedBy: [] },
        { id: "msg_2", direction: "incoming", isRead: false, viewedBy: [] },
      ],
    })
  );

  return client;
}

describe("applyOwnReadChange", () => {
  it("applies a read to every count the cache had one change before", () => {
    const client = seeded(10);
    expect(
      applyOwnReadChange(client, {
        mailboxId: "mbx",
        conversationId: "conv",
        messageId: "msg_1",
        isRead: true,
        version: 11,
        reader,
      })
    ).toBe(true);

    const conversation = required(
      cached(client, ["conversation", "mbx", "conv"], conversationSchema)
        .pages[0],
      "the conversation's first page"
    );

    expect(conversation).toMatchObject({ version: 11, unreadCount: 1 });
    expect(conversation.messages[0]).toMatchObject({
      isRead: true,
      viewedBy: [{ userId: "usr_me", name: "Me" }],
    });
    expect(conversation.messages[1]).toMatchObject({ isRead: false });
    expect(
      cached(client, ["conversations", "mbx", "inbox", "", false], pagedSchema)
        .pages[0]
    ).toMatchObject({
      version: 11,
      conversations: [
        { conversationId: "conv", unreadCount: 1, isUnread: true },
        { conversationId: "conv_other", unreadCount: 1, isUnread: true },
      ],
    });
    expect(cached(client, ["folders", "mbx"], foldersSchema)).toMatchObject({
      version: 11,
      folders: [
        { id: "inbox", unreadCount: 2 },
        { id: "project", unreadCount: 1 },
        { id: "archive", unreadCount: 1 },
      ],
    });
    expect(cached(client, ["mailboxes"], mailboxesSchema).mailboxes).toEqual([
      { id: "mbx", unreadCount: 2, version: 11 },
      { id: "mbx_other", unreadCount: 7, version: 40 },
    ]);
  });

  it("changes no count when the message already had that state", () => {
    const client = seeded(10);
    applyOwnReadChange(client, {
      mailboxId: "mbx",
      conversationId: "conv",
      messageId: "msg_1",
      isRead: false,
      version: 11,
      reader,
    });
    expect(
      cached(client, ["folders", "mbx"], foldersSchema).folders[0]
    ).toMatchObject({ unreadCount: 3 });
    expect(cached(client, ["folders", "mbx"], foldersSchema).version).toBe(11);
  });

  it("leaves the cache alone when another change came in between", () => {
    const client = seeded(9);
    const before = client.getQueryData(["folders", "mbx"]);
    expect(
      applyOwnReadChange(client, {
        mailboxId: "mbx",
        conversationId: "conv",
        messageId: "msg_1",
        isRead: true,
        version: 11,
        reader,
      })
    ).toBe(false);
    expect(client.getQueryData(["folders", "mbx"])).toBe(before);
  });
});

describe("noteMailboxVersion", () => {
  it("refetches only data older than the announced version", async () => {
    const client = seeded(10);
    client.setQueryData(
      ["conversation", "mbx", "conv_old"],
      page(8, { messages: [] })
    );
    noteMailboxVersion(client, "mbx", 10);
    await Bun.sleep(150);

    const invalidated = client
      .getQueryCache()
      .findAll()
      .filter((query) => query.state.isInvalidated)
      .map((query) => query.queryKey);

    expect(invalidated).toEqual([["conversation", "mbx", "conv_old"]]);
  });
});
