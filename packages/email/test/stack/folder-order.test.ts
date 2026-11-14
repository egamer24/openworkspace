import { beforeAll, describe, expect, it } from "bun:test";

import { required } from "@open-workspace/core/shared";
import { z } from "zod";

import { readJson } from "./json.ts";
import { bootstrapAdmin, firstMailboxId } from "./mail-flow-helpers.ts";
import { env, mailbox, useFreshWorkspace, worker } from "./workspace.ts";

useFreshWorkspace();

/**
 * A mailbox has one folder order: Inbox first, then system and custom
 * folders wherever they were placed. It is shared by everyone with access.
 */

let cookie: string;
let userId: string;
let mailboxId: string;

function call(path: string, init: RequestInit = {}) {
  return worker.fetch(
    new Request(`http://example.test${path}`, {
      ...init,
      headers: { cookie, "content-type": "application/json", ...init.headers },
    })
  );
}

async function listed() {
  const response = await call(`/api/mail/mailboxes/${mailboxId}/folders`);
  expect(response.status).toBe(200);

  const body = await readJson(
    response,
    z.object({
      folders: z.array(
        z.looseObject({
          id: z.string(),
          name: z.string(),
          sortOrder: z.number(),
        })
      ),
    })
  );

  return body.folders;
}

async function createFolder(name: string) {
  const response = await call(`/api/mail/mailboxes/${mailboxId}/folders`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });

  expect(response.status).toBe(201);

  return (
    await readJson(
      response,
      z.object({ folder: z.looseObject({ id: z.string() }) })
    )
  ).folder.id;
}

function reorder(folderIds: string[]) {
  return call(`/api/mail/mailboxes/${mailboxId}/folders/order`, {
    method: "PUT",
    body: JSON.stringify({ folderIds }),
  });
}

const names = (folders: { name: string }[]) =>
  folders.map((folder) => folder.name);

beforeAll(async () => {
  cookie = await bootstrapAdmin();
  mailboxId = await firstMailboxId(cookie);
  userId = required(
    await env.DB.prepare(
      "SELECT user_id FROM mailbox_access WHERE mailbox_id = ?"
    )
      .bind(mailboxId)
      .first<{ user_id: string }>(),
    "the admin has access to their mailbox"
  ).user_id;
});

describe("folder order", () => {
  it("places custom folders among system folders, Inbox first", async () => {
    // Until someone moves them, system folders come first and new folders go last.
    const product = await createFolder("Product");
    const decks = await createFolder("Pitch Decks");
    // Drafts follows Sent wherever Sent goes, outside the order.
    expect(names(await listed())).toEqual([
      "Inbox",
      "Sent",
      "Drafts",
      "Archive",
      "Spam",
      "Trash",
      "Product",
      "Pitch Decks",
    ]);

    // Product before Trash; Pitch Decks first after Inbox.
    const moved = await reorder([
      decks,
      "sent",
      "archive",
      "spam",
      product,
      "trash",
    ]);

    expect(moved.status).toBe(200);
    await moved.json();
    const folders = await listed();
    expect(names(folders)).toEqual([
      "Inbox",
      "Pitch Decks",
      "Sent",
      "Drafts",
      "Archive",
      "Spam",
      "Product",
      "Trash",
    ]);
    expect(folders.map((folder) => folder.sortOrder)).toEqual([
      0, 10, 20, 21, 30, 40, 50, 60,
    ]);

    // A folder created afterwards goes to the end, after Trash.
    await createFolder("Receipts");
    expect(names(await listed()).slice(-2)).toEqual(["Trash", "Receipts"]);

    // JMAP clients get the same order.
    const jmap = await mailbox(mailboxId).jmapMailboxes(userId);

    const jmapOrder = [...jmap.mailboxes]
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map((row) => row.name);

    expect(jmapOrder).toEqual([
      "Inbox",
      "Pitch Decks",
      "Sent",
      "Drafts",
      "Archive",
      "Spam",
      "Product",
      "Trash",
      "Receipts",
    ]);
  });

  it("takes only a complete order of every folder but Inbox", async () => {
    const before = names(await listed());

    const custom = (await listed()).filter(
      (folder) =>
        !["inbox", "sent", "drafts", "archive", "spam", "trash"].includes(
          folder.id
        )
    );

    const customIds = custom.map((folder) => folder.id);

    // Custom folders alone, without the system folders: incomplete, so refused.
    const customOnly = await reorder(customIds);
    expect(customOnly.status).toBe(409);
    await customOnly.json();

    // Inbox can't move.
    const withInbox = await reorder([
      "inbox",
      "sent",
      "archive",
      "spam",
      "trash",
      ...customIds,
    ]);

    expect(withInbox.status).toBe(409);
    await withInbox.json();
    // A system folder missing.
    const missing = await reorder(["sent", "archive", "spam", ...customIds]);
    expect(missing.status).toBe(409);
    await missing.json();

    // A duplicate.
    const duplicate = await reorder([
      "sent",
      "sent",
      "archive",
      "spam",
      "trash",
      ...customIds,
    ]);

    expect(duplicate.status).toBe(400);
    await duplicate.json();

    expect(names(await listed())).toEqual(before);
  });

  it("keeps system folders' names fixed", async () => {
    const rename = await call(
      `/api/mail/mailboxes/${mailboxId}/folders/trash`,
      {
        method: "PATCH",
        body: JSON.stringify({ name: "Bin" }),
      }
    );

    expect(rename.status).toBe(404);
    await rename.json();
    expect(names(await listed())).toContain("Trash");
  });
});
