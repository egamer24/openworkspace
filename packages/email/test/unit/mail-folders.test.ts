import { describe, expect, it } from "bun:test";

import {
  DEFAULT_SYSTEM_FOLDER_ORDER,
  folderOrderPositions,
  isCompleteFolderOrder,
  moveFolderInOrder,
} from "@open-workspace/email/shared/folder-order.ts";
import {
  folderAfterMailboxSwitch,
  orderedFolders,
} from "@open-workspace/email/src/mail/mail-folders.ts";
import type { MailFolder } from "@open-workspace/email/src/mail/types.ts";

type SystemType = Exclude<NonNullable<MailFolder["systemType"]>, "drafts">;

function systemFolder(
  id: SystemType,
  sortOrder = DEFAULT_SYSTEM_FOLDER_ORDER[id] ?? 100
): MailFolder {
  return {
    id,
    name: id,
    kind: "system",
    systemType: id,
    sortOrder,
    totalCount: 0,
    unreadCount: 0,
    retentionDays: null,
  };
}

function customFolder(id: string, sortOrder = 100): MailFolder {
  return {
    id,
    name: id,
    kind: "custom",
    systemType: null,
    sortOrder,
    totalCount: 0,
    unreadCount: 0,
    retentionDays: null,
  };
}

const ids = (folders: readonly { id: string }[]) =>
  folders.map((item) => item.id);

describe("orderedFolders", () => {
  it("lists system folders before custom ones until someone moves them", () => {
    const folders = [
      customFolder("Pitch Decks", 110),
      systemFolder("trash"),
      customFolder("Product", 100),
      systemFolder("sent"),
      systemFolder("archive"),
      systemFolder("inbox"),
      systemFolder("spam"),
    ];

    expect(ids(orderedFolders(folders))).toEqual([
      "inbox",
      "sent",
      "archive",
      "spam",
      "trash",
      "Product",
      "Pitch Decks",
    ]);
  });

  it("interleaves custom and system folders by position, Inbox always first", () => {
    const folders = [
      systemFolder("inbox", 50),
      systemFolder("sent", 10),
      customFolder("Product", 20),
      systemFolder("trash", 30),
      systemFolder("archive", 40),
    ];

    expect(ids(orderedFolders(folders))).toEqual([
      "inbox",
      "sent",
      "Product",
      "trash",
      "archive",
    ]);
  });

  it("breaks ties by name", () => {
    expect(
      ids(orderedFolders([customFolder("b", 10), customFolder("a", 10)]))
    ).toEqual(["a", "b"]);
  });
});

describe("folder order", () => {
  const folders = [
    systemFolder("inbox"),
    systemFolder("sent"),
    systemFolder("archive"),
    systemFolder("spam"),
    systemFolder("trash"),
    customFolder("Product", 100),
    customFolder("Pitch Decks", 110),
    // Drafts follows Sent and takes no part in the order.
    {
      ...systemFolder("sent"),
      id: "drafts",
      systemType: "drafts",
      sortOrder: 11,
    },
  ];

  it("moves a custom folder up past a system folder, leaving Inbox out", () => {
    expect(moveFolderInOrder(folders, "Product", -1)).toEqual([
      "sent",
      "archive",
      "spam",
      "Product",
      "trash",
      "Pitch Decks",
    ]);
  });

  it("moves a system folder down past a custom folder", () => {
    expect(moveFolderInOrder(folders, "trash", 1)).toEqual([
      "sent",
      "archive",
      "spam",
      "Product",
      "trash",
      "Pitch Decks",
    ]);
  });

  it("won't move past either end, or move Inbox", () => {
    expect(moveFolderInOrder(folders, "sent", -1)).toBeNull();
    expect(moveFolderInOrder(folders, "Pitch Decks", 1)).toBeNull();
    expect(moveFolderInOrder(folders, "inbox", 1)).toBeNull();
    expect(moveFolderInOrder(folders, "drafts", 1)).toBeNull();
    expect(moveFolderInOrder(folders, "missing", 1)).toBeNull();
  });

  it("accepts only a complete order of every folder but Inbox", () => {
    const custom = ["Product", "Pitch Decks"];
    expect(
      isCompleteFolderOrder(
        ["sent", "archive", "spam", "Product", "trash", "Pitch Decks"],
        custom
      )
    ).toBe(true);
    expect(isCompleteFolderOrder(["Pitch Decks", "Product"], custom)).toBe(
      false
    );
    expect(
      isCompleteFolderOrder(
        ["inbox", "sent", "archive", "spam", "trash", "Product", "Pitch Decks"],
        custom
      )
    ).toBe(false);
    expect(
      isCompleteFolderOrder(
        ["sent", "sent", "spam", "trash", "Product", "Pitch Decks"],
        custom
      )
    ).toBe(false);
    expect(
      isCompleteFolderOrder(
        ["sent", "archive", "spam", "trash", "Product", "Other"],
        custom
      )
    ).toBe(false);
  });

  it("stores positions after Inbox's 0, a step apart", () => {
    expect(folderOrderPositions(["sent", "Product"])).toEqual([
      { id: "sent", sortOrder: 10 },
      { id: "Product", sortOrder: 20 },
    ]);
  });
});

describe("folderAfterMailboxSwitch", () => {
  const target = [
    systemFolder("inbox"),
    systemFolder("sent"),
    customFolder("Product"),
  ];

  it("keeps a folder the other mailbox has", () => {
    expect(folderAfterMailboxSwitch("sent", target)).toBe("sent");
    expect(folderAfterMailboxSwitch("Product", target)).toBe("Product");
  });

  it("falls back to Inbox when the folder is missing or unknown", () => {
    expect(folderAfterMailboxSwitch("Pitch Decks", target)).toBe("inbox");
    expect(folderAfterMailboxSwitch("sent", undefined)).toBe("inbox");
  });
});
