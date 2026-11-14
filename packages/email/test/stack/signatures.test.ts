import { describe, expect, it } from "bun:test";

import { required } from "@open-workspace/core/shared";
import { z } from "zod";

import { readJson } from "./json.ts";
import { bootstrapAdmin, firstMailboxId } from "./mail-flow-helpers.ts";
import { env, mailbox, useFreshWorkspace, worker } from "./workspace.ts";

useFreshWorkspace();

const origin = "http://example.test";

function call(
  cookie: string,
  path: string,
  init: { method?: string; json?: unknown } = {}
) {
  const headers = new Headers({ cookie, origin });

  if (init.json !== undefined) headers.set("content-type", "application/json");

  return worker.fetch(
    new Request(`${origin}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
    })
  );
}

/** Uploads `bytes` as a PNG through the composer's upload flow; its upload id. */
async function uploadImage(cookie: string, mailboxId: string, bytes: string) {
  const intent = await readJson(
    await call(cookie, `/api/mail/uploads?mailboxId=${mailboxId}`, {
      method: "POST",
      json: {
        filename: "logo.png",
        contentType: "image/png",
        size: bytes.length,
      },
    }),
    z.looseObject({
      upload: z.looseObject({
        id: z.string(),
        uploadUrl: z.string(),
        headers: z.record(z.string(), z.string()),
      }),
    })
  );

  // Straight to the bucket's local S3 endpoint, as a browser would.
  const put = await fetch(intent.upload.uploadUrl, {
    method: "PUT",
    headers: intent.upload.headers,
    body: bytes,
  });

  expect(put.status).toBe(200);
  await put.arrayBuffer();

  const complete = await call(
    cookie,
    `/api/mail/uploads/${intent.upload.id}/complete?mailboxId=${mailboxId}`,
    { method: "POST" }
  );

  expect(complete.status).toBe(200);
  await complete.json();

  return intent.upload.id;
}

const sent = z.object({ messageId: z.string() });

async function send(cookie: string, mailboxId: string) {
  const response = await call(cookie, "/api/mail/messages", {
    method: "POST",
    json: {
      requestId: crypto.randomUUID(),
      mailboxId,
      to: ["someone@example.net"],
      subject: "Hello",
      bodyText: "Hi there",
      bodyHtml: "<p>Hi there</p>",
      includeSignature: true,
    },
  });

  const { messageId } = await readJson(response, sent);

  return required(
    await mailbox(mailboxId).getEmail(messageId),
    "the sent message is stored"
  );
}

async function storedHtml(key: string | null) {
  const object = await env.MAIL_STORAGE.get(required(key, "an HTML body"));

  return required(object, "the HTML body is in R2").text();
}

async function signatureKeys(ownerId: string) {
  const page = await env.MAIL_STORAGE.list({
    prefix: `signatures/${ownerId}/`,
  });

  return page.objects.map((object) => object.key);
}

const listedSignatures = z.object({
  mailboxes: z.array(
    z.looseObject({
      id: z.string(),
      signature: z
        .looseObject({ ownerId: z.string(), html: z.string() })
        .nullable(),
    })
  ),
});

describe("signatures", () => {
  it("sign mail from your own mailbox and from a team inbox, with images", async () => {
    const cookie = await bootstrapAdmin("admin@example.test", "Ana Admin");
    const personalId = await firstMailboxId(cookie);

    const admin = required(
      await env.DB.prepare("SELECT id FROM users WHERE role = 'admin'").first<{
        id: string;
      }>(),
      "the bootstrap creates an admin"
    );

    // Personal signature with an inline image.
    const logo = "inline-logo@openworkspace.local";
    const uploadId = await uploadImage(cookie, personalId, "png-bytes");

    const personal = await call(cookie, "/api/mail/signature", {
      method: "PUT",
      json: {
        html: `<p>Ana</p><p><img src="cid:${logo}" alt="logo.png"></p>`,
        text: "Ana\n\nlogo.png",
        images: [{ uploadId, contentId: logo }],
        uploadMailboxId: personalId,
        useOnReply: false,
      },
    });

    expect(personal.status).toBe(200);
    await personal.json();
    expect(await signatureKeys(admin.id)).toEqual([
      `signatures/${admin.id}/${logo}`,
    ]);

    const fromPersonal = await send(cookie, personalId);

    expect(fromPersonal.bodyText).toBe("Hi there\n\nAna\n\nlogo.png");
    expect(fromPersonal.attachmentsJson).toMatchObject([
      {
        contentId: logo,
        disposition: "inline",
        contentType: "image/png",
        size: 9,
      },
    ]);
    expect(await storedHtml(fromPersonal.bodyHtmlR2Key)).toContain(
      `<div data-rich-content><br><p>Ana</p><p><img src="cid:${logo}"`
    );

    // A team inbox's signature, with {name} for whoever sends.
    const team = await readJson(
      await call(cookie, "/api/admin/teams", {
        method: "POST",
        json: {
          name: "Support",
          slug: "support",
          description: null,
          members: [{ userId: admin.id, canSend: true }],
        },
      }),
      z.looseObject({ teamId: z.string() })
    );

    const { mailboxId: teamId } = await readJson(
      await call(cookie, "/api/admin/mailboxes", {
        method: "POST",
        json: {
          address: "support@example.test",
          displayName: "Support",
          ownerUserId: null,
          teamId: team.teamId,
        },
      }),
      z.looseObject({ mailboxId: z.string() })
    );

    expect((await send(cookie, teamId)).bodyText).toBe("Hi there");

    const teamLogo = "inline-team@openworkspace.local";
    const teamUpload = await uploadImage(cookie, personalId, "team-png");

    const shared = await call(cookie, `/api/mail/team-signatures/${teamId}`, {
      method: "PUT",
      json: {
        html: `<p>{name}</p><p>Support <img src="cid:${teamLogo}"></p>`,
        text: "{name}\n\nSupport",
        images: [{ uploadId: teamUpload, contentId: teamLogo }],
        uploadMailboxId: personalId,
      },
    });

    expect(shared.status).toBe(200);
    await shared.json();

    const fromTeam = await send(cookie, teamId);

    expect(fromTeam.bodyText).toBe("Hi there\n\nAna Admin\n\nSupport");
    expect(fromTeam.attachmentsJson).toMatchObject([
      { contentId: teamLogo, disposition: "inline" },
    ]);

    // A reply as the web app's editor sends it: the signature is in the body,
    // its image a reference to the stored copy, which the Worker sends inline.
    await mailbox(teamId).seedMailbox(
      [],
      [
        {
          id: "msg_customer",
          conversationId: "conv_customer",
          direction: "incoming",
          fromJson: [{ address: "customer@example.net", name: null }],
          toJson: [{ address: "support@example.test", name: null }],
          subject: "Help",
          timelineAt: new Date(),
          transportState: "received",
        },
      ],
      []
    );

    const reply = await call(
      cookie,
      "/api/mail/messages/msg_customer/replies",
      {
        method: "POST",
        json: {
          requestId: crypto.randomUUID(),
          mailboxId: teamId,
          mode: "reply",
          cc: [],
          bcc: [],
          bodyText: "Following up\n\nAna Admin\n\nSupport",
          bodyHtml: `<p>Following up</p><p></p><p>Ana Admin</p><p>Support <img src="cid:${teamLogo}" alt="logo.png"></p>`,
          attachments: [],
          storedImages: [{ ownerId: teamId, contentId: teamLogo }],
        },
      }
    );

    const { messageId: replyId } = await readJson(reply, sent);

    const replied = required(
      await mailbox(teamId).getEmail(replyId),
      "the reply is stored"
    );

    expect(replied.bodyText).toBe("Following up\n\nAna Admin\n\nSupport");
    expect(replied.attachmentsJson).toMatchObject([
      { contentId: teamLogo, disposition: "inline" },
    ]);
    expect(await storedHtml(replied.bodyHtmlR2Key)).toContain(
      `<img src="cid:${teamLogo}"`
    );

    // Only the sender's own and the sending address's images can be used.
    const borrowed = await call(cookie, "/api/mail/messages", {
      method: "POST",
      json: {
        requestId: crypto.randomUUID(),
        mailboxId: personalId,
        to: ["someone@example.net"],
        subject: "Borrowed",
        bodyText: "Hi",
        bodyHtml: `<p>Hi <img src="cid:${teamLogo}"></p>`,
        storedImages: [{ ownerId: teamId, contentId: teamLogo }],
      },
    });

    expect(borrowed.status).toBe(400);
    await borrowed.json();

    // Saving again keeps a stored image by its content id, without an upload.
    const kept = await call(cookie, `/api/mail/team-signatures/${teamId}`, {
      method: "PUT",
      json: {
        html: `<p>{name}</p><p>Support team <img src="cid:${teamLogo}"></p>`,
        text: "{name}\n\nSupport team",
        images: [{ contentId: teamLogo }],
      },
    });

    expect(kept.status).toBe(200);
    expect(await kept.json()).toMatchObject({
      signature: { images: [{ contentId: teamLogo, size: 8 }] },
    });
    expect(await signatureKeys(teamId)).toEqual([
      `signatures/${teamId}/${teamLogo}`,
    ]);

    // The list carries the signature each mailbox sends with.
    const list = await readJson(
      await call(cookie, "/api/mail/mailboxes"),
      listedSignatures
    );

    expect(
      Object.fromEntries(
        list.mailboxes.map((row) => [row.id, row.signature?.ownerId])
      )
    ).toEqual({ [personalId]: admin.id, [teamId]: teamId });

    // Replacing the personal signature drops its old image.
    const replaced = await call(cookie, "/api/mail/signature", {
      method: "PUT",
      json: { html: "<p>Ana</p>", text: "Ana" },
    });

    expect(replaced.status).toBe(200);
    await replaced.json();
    expect(await signatureKeys(admin.id)).toEqual([]);

    // Deleting the team address deletes its signature and images.
    expect(await signatureKeys(teamId)).toHaveLength(1);

    const deleted = await call(cookie, `/api/admin/mailboxes/${teamId}`, {
      method: "DELETE",
    });

    expect(deleted.status).toBe(200);
    await deleted.json();
    expect(await signatureKeys(teamId)).toEqual([]);

    const rows = await env.DB.prepare(
      "SELECT user_id AS userId, mailbox_id AS mailboxId, html FROM signatures"
    ).all();

    expect(rows.results).toEqual([
      { userId: admin.id, mailboxId: null, html: "<p>Ana</p>" },
    ]);

    // Emptying it removes it.
    const removed = await call(cookie, "/api/mail/signature", {
      method: "PUT",
      json: { html: "<p></p>", text: "" },
    });

    expect(await removed.json()).toMatchObject({ signature: null });
    expect((await send(cookie, personalId)).bodyText).toBe("Hi there");
  });
});
