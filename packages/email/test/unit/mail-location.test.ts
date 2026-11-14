import { describe, expect, it } from "bun:test";

import {
  mailPath,
  parseMailPath,
} from "@open-workspace/email/shared/mail-path.ts";
import {
  resolveMailLocation,
  routePath,
} from "@open-workspace/email/src/mail/mail-location.ts";

const mailboxes = [
  {
    id: "mailbox-a",
    address: "a@example.test",
    displayName: "A",
    kind: "personal" as const,
    canSend: true,
    unreadCount: 0,
    version: 0,
  },
  {
    id: "mailbox-read-only",
    address: "readonly@example.test",
    displayName: "Read only",
    kind: "shared" as const,
    canSend: false,
    unreadCount: 0,
    version: 0,
  },
];

const folders = [
  {
    id: "inbox",
    name: "Inbox",
    kind: "system" as const,
    systemType: "inbox" as const,
    sortOrder: 0,
    totalCount: 0,
    unreadCount: 0,
    retentionDays: null,
    version: 0,
  },
  {
    id: "project",
    name: "Project",
    kind: "custom" as const,
    systemType: null,
    sortOrder: 100,
    totalCount: 0,
    unreadCount: 0,
    retentionDays: null,
    version: 0,
  },
];

describe("mail paths", () => {
  it("leaves Inbox out unless a conversation is open, and encodes each segment", () => {
    expect(mailPath("mailbox-a")).toBe("/mail/mailbox-a");
    expect(mailPath("mailbox-a", "inbox")).toBe("/mail/mailbox-a");
    expect(mailPath("mailbox-a", "Pitch Decks")).toBe(
      "/mail/mailbox-a/Pitch%20Decks"
    );
    expect(mailPath("mailbox-a", "inbox", "conv/1")).toBe(
      "/mail/mailbox-a/inbox/conv%2F1"
    );
  });

  it("reads mailbox, folder and conversation back", () => {
    expect(parseMailPath("/mail/mailbox-a")).toEqual({
      mailboxId: "mailbox-a",
      folder: "inbox",
      conversationId: null,
    });
    expect(parseMailPath("/mail/mailbox-a/Pitch%20Decks/")).toEqual({
      mailboxId: "mailbox-a",
      folder: "Pitch Decks",
      conversationId: null,
    });
    expect(parseMailPath("/mail/mailbox-a/sent/conv%2F1")).toEqual({
      mailboxId: "mailbox-a",
      folder: "sent",
      conversationId: "conv/1",
    });
    expect(parseMailPath("/mail/mailbox-a/sent/conv/extra")).toBeNull();
    expect(parseMailPath("/mail/%E0%A4%A")).toBeNull();
    expect(parseMailPath("/settings")).toBeNull();
  });

  it("spells a route's segments as given", () => {
    expect(routePath({})).toBe("/");
    expect(routePath({ mailboxId: "mailbox-a", folder: "inbox" })).toBe(
      "/mail/mailbox-a/inbox"
    );
  });
});

describe("mail location", () => {
  it("keeps a valid deep link", () => {
    const location = resolveMailLocation(
      {
        mailboxId: "mailbox-a",
        folder: "project",
        conversationId: "conversation-a",
      },
      mailboxes,
      folders
    );

    expect(location).toMatchObject({
      mailbox: { id: "mailbox-a" },
      folder: "project",
      conversationId: "conversation-a",
      ready: true,
    });
    expect(location.canonicalPath).toBe(
      "/mail/mailbox-a/project/conversation-a"
    );
  });

  it("drops /inbox from the canonical path of the Inbox", () => {
    const location = resolveMailLocation(
      { mailboxId: "mailbox-a", folder: "inbox" },
      mailboxes,
      folders
    );

    expect(location.canonicalPath).toBe("/mail/mailbox-a");
  });

  it("falls back atomically when mailbox or folder is stale", () => {
    const location = resolveMailLocation(
      {
        mailboxId: "removed-mailbox",
        folder: "removed-folder",
        conversationId: "stale-conversation",
      },
      mailboxes,
      folders
    );

    expect(location).toMatchObject({
      mailbox: { id: "mailbox-a" },
      folder: "inbox",
      conversationId: undefined,
    });
    expect(location.canonicalPath).toBe("/mail/mailbox-a");
  });

  it("uses a deep link before folders load, so its data loads in parallel", () => {
    const location = resolveMailLocation(
      {
        mailboxId: "mailbox-a",
        folder: "project",
        conversationId: "conversation-a",
      },
      mailboxes,
      undefined
    );

    expect(location).toMatchObject({
      mailboxId: "mailbox-a",
      folder: "project",
      conversationId: "conversation-a",
      ready: false,
    });
  });

  it("uses the URL's mailbox before the mailbox list arrives", () => {
    const location = resolveMailLocation(
      {
        mailboxId: "mailbox-unverified",
        folder: "inbox",
        conversationId: "conversation-a",
      },
      undefined,
      undefined
    );

    expect(location).toMatchObject({
      mailbox: undefined,
      mailboxId: "mailbox-unverified",
      folder: "inbox",
      conversationId: "conversation-a",
      ready: false,
    });
  });

  it("needs the mailbox list for the default mailbox", () => {
    const location = resolveMailLocation({}, undefined, undefined);
    expect(location).toMatchObject({
      mailboxId: undefined,
      conversationId: undefined,
    });
  });
});
