import { describe, expect, it } from "bun:test";

import {
  createDb,
  mailboxes,
  teamMembers,
  teams,
  users,
} from "@open-workspace/core/module";
import { required } from "@open-workspace/core/shared";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { readJson } from "./json.ts";
import {
  env,
  mailbox as mailboxObject,
  useFreshWorkspace,
  worker,
} from "./workspace.ts";

useFreshWorkspace();

const createdFolderBody = z.object({ folder: z.object({ id: z.string() }) });

const foldersBody = z.object({
  folders: z.array(
    z.object({ id: z.string(), name: z.string(), kind: z.string() })
  ),
});

describe("read-only mailbox access", () => {
  it("can read stored mail but cannot send or send again", async () => {
    const bootstrap = await worker.fetch(
      new Request("http://example.test/api/auth/mock/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Admin", email: "admin@example.test" }),
      })
    );

    expect(bootstrap.status).toBe(200);
    await bootstrap.json();

    const db = createDb(env.DB);

    const [adminRow] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, "admin"))
      .limit(1);

    const admin = required(adminRow, "bootstrap created an administrator");

    const userId = `usr_read_only_${crypto.randomUUID()}`;
    const mailboxId = `mbx_read_only_${crypto.randomUUID()}`;
    const teamId = `team_read_only_${crypto.randomUUID()}`;
    const now = new Date();
    await db.batch([
      db.insert(users).values({
        id: userId,
        name: "Reader",
        role: "member",
        status: "active",
        createdAt: now,
        updatedAt: now,
      }),
      db.insert(teams).values({
        id: teamId,
        name: "Readers",
        slug: `readers-${teamId.slice(-8)}`,
        createdByUserId: admin.id,
        createdAt: now,
        updatedAt: now,
      }),
      db.insert(teamMembers).values({
        teamId,
        userId,
        canSend: false,
        createdAt: now,
      }),
      db.insert(mailboxes).values({
        id: mailboxId,
        localPart: "readonly",
        domain: "example.test",
        displayName: "Read only",
        ownerUserId: null,
        teamId,
        createdByUserId: admin.id,
        createdAt: now,
        updatedAt: now,
      }),
    ] as const);

    const mailbox = mailboxObject(mailboxId);
    await mailbox.seedMailbox(
      [],
      [
        {
          id: "msg_visible_incoming",
          conversationId: "conv_visible",
          direction: "incoming",
          messageIdHeader: "<visible@example.net>",
          fromJson: [{ address: "visible@example.net", name: null }],
          toJson: [{ address: "readonly@example.test", name: null }],
          subject: "Visible incoming",
          timelineAt: now,
          transportState: "received",
        },
        {
          id: "msg_visible_unconfirmed",
          conversationId: "conv_visible_failed",
          direction: "outgoing",
          fromJson: [{ address: "readonly@example.test", name: null }],
          toJson: [{ address: "recipient@example.net", name: null }],
          subject: "Visible failed send",
          timelineAt: now,
          transportState: "unconfirmed",
        },
      ]
    );

    const login = await worker.fetch(
      new Request("http://example.test/api/auth/mock/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId }),
      })
    );

    expect(login.status).toBe(200);

    const cookie = required(
      login.headers.get("set-cookie")?.split(";", 1)[0],
      "login sets a session cookie"
    );

    expect(cookie).toBeTruthy();
    await login.json();

    const list = await worker.fetch(
      new Request(
        `http://example.test/api/mail/conversations?mailboxId=${mailboxId}&folder=inbox`,
        { headers: { cookie } }
      )
    );

    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      conversations: [{ conversationId: "conv_visible" }],
    });

    const updateAiRules = await worker.fetch(
      new Request(`http://example.test/api/mail/mailboxes/${mailboxId}/ai`, {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          instructions: "Route urgent customer reports to Support.",
          confidenceThreshold: 85,
        }),
      })
    );

    expect(updateAiRules.status).toBe(200);
    expect(await updateAiRules.json()).toMatchObject({
      settings: {
        globalEnabled: false,
        configuration: {
          instructions: "Route urgent customer reports to Support.",
          confidenceThreshold: 85,
        },
      },
    });

    const createFirstFolder = await worker.fetch(
      new Request(
        `http://example.test/api/mail/mailboxes/${mailboxId}/folders`,
        {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ name: "Product" }),
        }
      )
    );

    expect(createFirstFolder.status).toBe(201);

    const firstFolder = await readJson(createFirstFolder, createdFolderBody);

    const createSecondFolder = await worker.fetch(
      new Request(
        `http://example.test/api/mail/mailboxes/${mailboxId}/folders`,
        {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ name: "Customers" }),
        }
      )
    );

    expect(createSecondFolder.status).toBe(201);

    const secondFolder = await readJson(createSecondFolder, createdFolderBody);

    const reservedFolder = await worker.fetch(
      new Request(
        `http://example.test/api/mail/mailboxes/${mailboxId}/folders`,
        {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ name: "inbox" }),
        }
      )
    );

    expect(reservedFolder.status).toBe(409);
    await reservedFolder.json();

    const renameFolder = await worker.fetch(
      new Request(
        `http://example.test/api/mail/mailboxes/${mailboxId}/folders/${firstFolder.folder.id}`,
        {
          method: "PATCH",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ name: "Launch" }),
        }
      )
    );

    expect(renameFolder.status).toBe(200);
    await renameFolder.json();

    const reorderFolders = await worker.fetch(
      new Request(
        `http://example.test/api/mail/mailboxes/${mailboxId}/folders/order`,
        {
          method: "PUT",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({
            folderIds: [
              "sent",
              "archive",
              "spam",
              "trash",
              secondFolder.folder.id,
              firstFolder.folder.id,
            ],
          }),
        }
      )
    );

    expect(reorderFolders.status).toBe(200);
    await reorderFolders.json();

    const reorderedFolders = await worker.fetch(
      new Request(
        `http://example.test/api/mail/mailboxes/${mailboxId}/folders`,
        { headers: { cookie } }
      )
    );

    const reorderedBody = await readJson(reorderedFolders, foldersBody);

    expect(
      reorderedBody.folders.flatMap((folder) =>
        folder.kind === "custom" ? [folder.name] : []
      )
    ).toEqual(["Customers", "Launch"]);

    const moveToFolder = await worker.fetch(
      new Request(
        `http://example.test/api/mail/conversations/bulk?mailboxId=${mailboxId}`,
        {
          method: "PATCH",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({
            type: "update",
            conversationIds: ["conv_visible"],
            sourceFolderId: "inbox",
            update: {
              mailboxState: "active",
              folderId: firstFolder.folder.id,
            },
          }),
        }
      )
    );

    expect(moveToFolder.status).toBe(200);
    await moveToFolder.json();

    const deleteFolder = await worker.fetch(
      new Request(
        `http://example.test/api/mail/mailboxes/${mailboxId}/folders/${firstFolder.folder.id}`,
        { method: "DELETE", headers: { cookie } }
      )
    );

    expect(deleteFolder.status).toBe(200);
    await deleteFolder.json();
    expect(await mailbox.getConversationSnapshot("conv_visible")).toMatchObject(
      { mailboxState: "active", folderId: null }
    );

    const conversation = await worker.fetch(
      new Request(
        `http://example.test/api/mail/conversations/conv_visible?mailboxId=${mailboxId}`,
        { headers: { cookie } }
      )
    );

    expect(conversation.status).toBe(200);
    await conversation.json();

    const markRead = await worker.fetch(
      new Request(
        `http://example.test/api/mail/messages/msg_visible_incoming/read?mailboxId=${mailboxId}`,
        {
          method: "PATCH",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ isRead: true }),
        }
      )
    );

    expect(markRead.status).toBe(200);
    await markRead.json();

    const readConversation = await worker.fetch(
      new Request(
        `http://example.test/api/mail/conversations/conv_visible?mailboxId=${mailboxId}`,
        { headers: { cookie } }
      )
    );

    expect(await readConversation.json()).toMatchObject({
      messages: [
        {
          id: "msg_visible_incoming",
          isRead: true,
          viewedBy: [{ userId, name: "Reader" }],
        },
      ],
    });

    const markConversationUnread = await worker.fetch(
      new Request(
        `http://example.test/api/mail/conversations/bulk?mailboxId=${mailboxId}`,
        {
          method: "PATCH",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({
            type: "read",
            conversationIds: ["conv_visible"],
            isRead: false,
          }),
        }
      )
    );

    expect(markConversationUnread.status).toBe(200);
    expect(await markConversationUnread.json()).toMatchObject({
      updatedCount: 1,
    });

    const unreadConversation = await worker.fetch(
      new Request(
        `http://example.test/api/mail/conversations/conv_visible?mailboxId=${mailboxId}`,
        { headers: { cookie } }
      )
    );

    expect(await unreadConversation.json()).toMatchObject({
      messages: [{ id: "msg_visible_incoming", isRead: false }],
    });

    const bulkRead = await worker.fetch(
      new Request(
        `http://example.test/api/mail/conversations/bulk?mailboxId=${mailboxId}`,
        {
          method: "PATCH",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({
            type: "read",
            conversationIds: ["conv_visible"],
            isRead: true,
          }),
        }
      )
    );

    expect(bulkRead.status).toBe(200);
    expect(await bulkRead.json()).toMatchObject({ updatedCount: 1 });

    const bulkTrash = await worker.fetch(
      new Request(
        `http://example.test/api/mail/conversations/bulk?mailboxId=${mailboxId}`,
        {
          method: "PATCH",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({
            type: "update",
            conversationIds: ["conv_visible"],
            sourceFolderId: "inbox",
            update: { mailboxState: "trash" },
          }),
        }
      )
    );

    expect(bulkTrash.status).toBe(200);
    expect(await bulkTrash.json()).toMatchObject({ updatedCount: 1 });

    const permanentDelete = await worker.fetch(
      new Request(
        `http://example.test/api/mail/conversations/bulk?mailboxId=${mailboxId}`,
        {
          method: "PATCH",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({
            type: "delete_permanently",
            conversationIds: ["conv_visible"],
          }),
        }
      )
    );

    expect(permanentDelete.status).toBe(403);
    expect(
      await mailbox.getConversationSnapshot("conv_visible")
    ).not.toBeNull();

    // Emptying deletes permanently too, so it needs send access.
    const empty = await worker.fetch(
      new Request(
        `http://example.test/api/mail/mailboxes/${mailboxId}/folders/trash/empty`,
        { method: "POST", headers: { cookie } }
      )
    );

    expect(empty.status).toBe(403);
    expect(
      await mailbox.getConversationSnapshot("conv_visible")
    ).not.toBeNull();

    // A team inbox's signature is for people who manage teams.
    const signatureCalls = await Promise.all(
      ["GET", "PUT"].map((method) =>
        worker.fetch(
          new Request(
            `http://example.test/api/mail/team-signatures/${mailboxId}`,
            {
              method,
              headers: { cookie, "content-type": "application/json" },
              body:
                method === "PUT"
                  ? JSON.stringify({ html: "<p>Reader</p>", text: "Reader" })
                  : undefined,
            }
          )
        )
      )
    );

    expect(signatureCalls.map((response) => response.status)).toEqual([
      403, 403,
    ]);
    await Promise.all(signatureCalls.map((response) => response.json()));

    expect(
      await env.DB.prepare("SELECT count(*) AS count FROM signatures").first()
    ).toEqual({ count: 0 });

    // A team inbox's auto-reply is the team's: for people who manage teams.
    const autoReplyCalls = await Promise.all(
      ["GET", "PUT"].map((method) =>
        worker.fetch(
          new Request(
            `http://example.test/api/mail/mailboxes/${mailboxId}/auto-reply`,
            {
              method,
              headers: { cookie, "content-type": "application/json" },
              body:
                method === "PUT"
                  ? JSON.stringify({
                      enabled: true,
                      inside: {
                        enabled: true,
                        html: "<p>Away</p>",
                        text: "Away",
                      },
                      outside: {
                        enabled: true,
                        html: "<p>Away</p>",
                        text: "Away",
                      },
                    })
                  : undefined,
            }
          )
        )
      )
    );

    expect(autoReplyCalls.map((response) => response.status)).toEqual([
      403, 403,
    ]);
    await Promise.all(autoReplyCalls.map((response) => response.json()));
    expect(await mailbox.getAutoReply()).toBeNull();

    const compose = await worker.fetch(
      new Request("http://example.test/api/mail/messages", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          mailboxId,
          to: ["recipient@example.net"],
          subject: "Forbidden compose",
          bodyText: "A read-only member cannot send.",
        }),
      })
    );

    expect(compose.status).toBe(403);
    await compose.json();

    const resend = await worker.fetch(
      new Request(
        `http://example.test/api/mail/messages/msg_visible_unconfirmed/send-again?mailboxId=${mailboxId}`,
        { method: "POST", headers: { cookie } }
      )
    );

    expect(resend.status).toBe(403);
    await resend.json();
  });
});
