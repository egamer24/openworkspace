import { describe, expect, it } from "vitest";
import { resolveMailLocation } from "../src/mail/mail-location";

const mailboxes = [{
  id: "mailbox-a",
  address: "a@example.test",
  displayName: "A",
  kind: "personal" as const,
  canSend: true,
  unreadCount: 0,
  autoReply: null,
}, {
  id: "mailbox-read-only",
  address: "readonly@example.test",
  displayName: "Read only",
  kind: "shared" as const,
  canSend: false,
  unreadCount: 0,
  autoReply: null,
}];

const folders = [
  {
    id: "inbox",
    name: "Inbox",
    kind: "system" as const,
    systemType: "inbox" as const,
    totalCount: 0,
    unreadCount: 0,
  },
  {
    id: "project",
    name: "Project",
    kind: "custom" as const,
    systemType: null,
    totalCount: 0,
    unreadCount: 0,
  },
];

describe("mail location", () => {
  it("keeps a valid deep link", () => {
    const params = new URLSearchParams({
      folder: "project",
      conversation: "conversation-a",
    });

    const location = resolveMailLocation(
      "mailbox-a",
      params,
      mailboxes,
      folders,
    );
    expect(location).toMatchObject({
      mailbox: { id: "mailbox-a" },
      folder: "project",
      conversationId: "conversation-a",
      ready: true,
    });
    expect(location.canonicalParams.toString()).toBe(
      "folder=project&conversation=conversation-a",
    );
  });

  it("falls back atomically when mailbox or folder is stale", () => {
    const params = new URLSearchParams({
      folder: "removed-folder",
      conversation: "stale-conversation",
    });

    const location = resolveMailLocation(
      "removed-mailbox",
      params,
      mailboxes,
      folders,
    );
    expect(location).toMatchObject({
      mailbox: { id: "mailbox-a" },
      folder: "inbox",
      conversationId: undefined,
    });
    expect(location.canonicalParams.toString()).toBe(
      "folder=inbox",
    );
  });

  it("waits for folders before accepting a deep link", () => {
    const location = resolveMailLocation(
      "mailbox-a",
      new URLSearchParams({
        folder: "project",
        conversation: "conversation-a",
      }),
      mailboxes,
      undefined,
    );

    expect(location).toMatchObject({
      folder: "project",
      conversationId: undefined,
      ready: false,
    });
  });
});
