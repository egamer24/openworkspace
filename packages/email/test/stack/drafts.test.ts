import { describe, expect, it } from "bun:test";

import { required } from "@open-workspace/core/shared";
import type { saveDraftSchema } from "@open-workspace/email/worker/mail/schemas.ts";
import { draftFileKey } from "@open-workspace/email/worker/mail/uploads.ts";
import { z } from "zod";

import { bootstrapAdmin, firstMailboxId } from "./mail-flow-helpers.ts";
import { runAlarmUntil } from "./mailbox-helpers.ts";
import { env, mailbox, useFreshWorkspace, worker } from "./workspace.ts";

useFreshWorkspace();

// One workspace per file: the admin is bootstrapped once.
let signedIn: Promise<{ cookie: string; mailboxId: string }> | undefined;

function signIn() {
  signedIn ??= (async () => {
    const cookie = await bootstrapAdmin();

    return { cookie, mailboxId: await firstMailboxId(cookie) };
  })();

  return signedIn;
}

type DraftSave = z.input<typeof saveDraftSchema>;

async function adminId() {
  return required(
    await env.DB.prepare("SELECT id FROM users WHERE role = 'admin'").first<{
      id: string;
    }>(),
    "the bootstrap creates an admin"
  ).id;
}

function mailApi(cookie: string, path: string, init: RequestInit = {}) {
  return worker.fetch(
    new Request(`http://example.test/api/mail${path}`, {
      ...init,
      headers: { cookie, "content-type": "application/json" },
    })
  );
}

/** Uploads a file through the composer's upload flow; its upload id. */
async function uploadFile(
  cookie: string,
  mailboxId: string,
  filename: string,
  contentType: string,
  body: string
) {
  const intent = z
    .object({
      upload: z.looseObject({ id: z.string(), uploadUrl: z.string() }),
    })
    .parse(
      await (
        await mailApi(cookie, `/uploads?mailboxId=${mailboxId}`, {
          method: "POST",
          body: JSON.stringify({
            filename,
            contentType,
            size: new TextEncoder().encode(body).byteLength,
          }),
        })
      ).json()
    ).upload;

  // Straight to the bucket's local S3 endpoint, as a browser would.
  const put = await fetch(intent.uploadUrl, {
    method: "PUT",
    headers: { "content-type": contentType },
    body,
  });

  expect(put.status).toBe(200);
  await put.arrayBuffer();

  const complete = await mailApi(
    cookie,
    `/uploads/${intent.id}/complete?mailboxId=${mailboxId}`,
    { method: "POST" }
  );

  expect(complete.status).toBe(200);
  await complete.json();

  return intent.id;
}

const draftBody = z.object({
  draft: z.object({ id: z.string(), version: z.number(), subject: z.string() }),
});

const conflictBody = z.object({
  error: z.object({ code: z.literal("DRAFT_CHANGED") }),
  draft: z.object({ version: z.number(), subject: z.string() }),
});

const listBody = z.object({
  drafts: z.array(
    z.object({ id: z.string(), version: z.number(), to: z.array(z.string()) })
  ),
});

describe("server-side drafts", () => {
  it("saves with version checks, and the message sent from it deletes it", async () => {
    const { cookie, mailboxId } = await signIn();
    const draftId = `drf_${crypto.randomUUID()}`;

    const save = (expectedVersion: number, subject: string) =>
      worker.fetch(
        new Request(
          `http://example.test/api/mail/drafts/${draftId}?mailboxId=${mailboxId}`,
          {
            method: "PUT",
            headers: { cookie, "content-type": "application/json" },
            body: JSON.stringify({
              expectedVersion,
              kind: "compose",
              to: ["friend@example.net"],
              subject,
              bodyText: "Half a thought",
              bodyHtml: "<p>Half a thought</p>",
            }),
          }
        )
      );

    const list = async () =>
      listBody.parse(
        await (
          await worker.fetch(
            new Request(
              `http://example.test/api/mail/drafts?mailboxId=${mailboxId}`,
              { headers: { cookie } }
            )
          )
        ).json()
      ).drafts;

    const created = await save(0, "First");

    expect(created.status).toBe(200);
    expect(draftBody.parse(await created.json()).draft.version).toBe(1);

    const updated = await save(1, "Second");

    expect(updated.status).toBe(200);
    expect(draftBody.parse(await updated.json()).draft.version).toBe(2);

    // A window still at version 1 is told, with what is saved now.
    const stale = await save(1, "Stale");

    expect(stale.status).toBe(409);
    expect(conflictBody.parse(await stale.json()).draft).toMatchObject({
      version: 2,
      subject: "Second",
    });

    expect(await list()).toEqual([
      expect.objectContaining({
        id: draftId,
        version: 2,
        to: ["friend@example.net"],
      }),
    ]);
    // Drafts are keyed by their author.
    expect(await mailbox(mailboxId).listDrafts("usr_someone_else")).toEqual([]);

    const sent = await worker.fetch(
      new Request("http://example.test/api/mail/messages", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          draftId,
          mailboxId,
          to: ["friend@example.net"],
          subject: "Second",
          bodyText: "Half a thought",
        }),
      })
    );

    expect(sent.status).toBe(201);
    await sent.json();
    expect(await list()).toEqual([]);

    // A save still in flight from before the send can't bring it back.
    const late = await save(2, "Late");

    expect(late.status).toBe(409);
    await late.json();

    // Discarding deletes it.
    const again = await save(0, "Again");

    expect(again.status).toBe(200);
    await again.json();

    const discarded = await worker.fetch(
      new Request(
        `http://example.test/api/mail/drafts/${draftId}?mailboxId=${mailboxId}`,
        { method: "DELETE", headers: { cookie } }
      )
    );

    expect(discarded.status).toBe(200);
    await discarded.json();
    expect(await list()).toEqual([]);
  });

  it("keeps attachments and inline images outside the expiring uploads until sent or discarded", async () => {
    const { cookie, mailboxId } = await signIn();
    const userId = await adminId();

    const api = (path: string, init: RequestInit = {}) =>
      mailApi(cookie, path, init);

    const upload = (filename: string, contentType: string, body: string) =>
      uploadFile(cookie, mailboxId, filename, contentType, body);

    const held = (uploadId: string) =>
      env.MAIL_STORAGE.head(draftFileKey(mailboxId, userId, uploadId));

    const notes = await upload("notes.txt", "text/plain", "the notes");
    const pixel = await upload("pixel.png", "image/png", "not really a png");
    const extra = await upload("extra.txt", "text/plain", "removed later");
    const draftId = `drf_${crypto.randomUUID()}`;
    const contentId = "inline-1@openworkspace.local";

    const files = {
      notes: {
        assetId: crypto.randomUUID(),
        uploadId: notes,
        disposition: "attachment",
      },
      pixel: {
        assetId: crypto.randomUUID(),
        uploadId: pixel,
        disposition: "inline",
        contentId,
      },
      extra: {
        assetId: crypto.randomUUID(),
        uploadId: extra,
        disposition: "attachment",
      },
    };

    type DraftFile = {
      assetId: string;
      uploadId: string;
      disposition: string;
      contentId?: string;
    };

    const save = (expectedVersion: number, attachments: DraftFile[]) =>
      api(`/drafts/${draftId}?mailboxId=${mailboxId}`, {
        method: "PUT",
        body: JSON.stringify({
          expectedVersion,
          kind: "compose",
          to: ["friend@example.net"],
          subject: "With files",
          bodyText: "See attached",
          bodyHtml: `<p>See attached<span data-composer-asset="${files.pixel.assetId}" data-composer-asset-intent="inline"></span></p>`,
          attachments,
        }),
      });

    const first = await save(0, [files.notes, files.pixel, files.extra]);

    expect(first.status).toBe(200);
    await first.json();

    for (const uploadId of [notes, pixel, extra]) {
      expect(draftFileKey(mailboxId, userId, uploadId)).not.toStartWith(
        "composer-uploads/"
      );
      // oxlint-disable-next-line eslint/no-await-in-loop -- three heads, order doesn't matter
      expect(await held(uploadId)).not.toBeNull();
    }

    // The drafts list gives the composer what it needs to rebuild them.
    const listed = z
      .object({
        drafts: z.array(z.object({ attachments: z.array(z.looseObject({})) })),
      })
      .parse(await (await api(`/drafts?mailboxId=${mailboxId}`)).json());

    expect(listed.drafts[0]?.attachments).toEqual([
      expect.objectContaining({
        ...files.notes,
        filename: "notes.txt",
        size: 9,
        contentId: null,
      }),
      expect.objectContaining({
        ...files.pixel,
        filename: "pixel.png",
        contentType: "image/png",
      }),
      expect.objectContaining({ ...files.extra, filename: "extra.txt" }),
    ]);
    expect(listed.drafts[0]?.attachments[0]).not.toHaveProperty("r2Key");

    // The inline image is served for the composer; other files aren't.
    const image = await api(`/drafts/files/${pixel}?mailboxId=${mailboxId}`);

    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(await image.text()).toBe("not really a png");

    const text = await api(`/drafts/files/${notes}?mailboxId=${mailboxId}`);

    expect(text.status).toBe(404);
    await text.json();

    // Another person's key holds nothing, and their drafts list is empty.
    expect(
      await env.MAIL_STORAGE.head(
        draftFileKey(mailboxId, "usr_someone_else", pixel)
      )
    ).toBeNull();
    expect(await mailbox(mailboxId).listDrafts("usr_someone_else")).toEqual([]);

    // The composer's limits apply: an inline file must be an image, and
    // there are at most ten.
    const notAnImage = await save(1, [
      {
        ...files.notes,
        disposition: "inline",
        contentId: "x@openworkspace.local",
      },
    ]);

    expect(notAnImage.status).toBe(400);
    await notAnImage.json();

    const tooMany = await save(
      1,
      Array.from({ length: 11 }, (_, index) => ({
        ...files.notes,
        assetId: crypto.randomUUID(),
        uploadId: `upl_${index.toString(16).padStart(32, "0")}`,
      }))
    );

    expect(tooMany.status).toBe(400);
    await tooMany.json();

    // Removing an attachment and saving deletes its file.
    const second = await save(1, [files.notes, files.pixel]);

    expect(second.status).toBe(200);
    await second.json();
    await runAlarmUntil(mailboxId, async () => (await held(extra)) === null);

    // Seven days later the uploads have expired; the draft still sends them.
    const discardedUploads = await Promise.all(
      [notes, pixel].map((uploadId) =>
        api(`/uploads/${uploadId}?mailboxId=${mailboxId}`, { method: "DELETE" })
      )
    );

    for (const response of discardedUploads) {
      expect(response.status).toBe(200);
      // oxlint-disable-next-line eslint/no-await-in-loop -- reading two small bodies
      await response.json();
    }

    const sent = await api("/messages", {
      method: "POST",
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        draftId,
        mailboxId,
        to: ["friend@example.net"],
        subject: "With files",
        bodyText: "See attached",
        bodyHtml: `<p>See attached<img src="cid:${contentId}"></p>`,
        attachments: [
          { uploadId: notes },
          { uploadId: pixel, disposition: "inline", contentId },
        ],
      }),
    });

    expect(sent.status).toBe(201);

    const { messageId } = z
      .object({ messageId: z.string() })
      .parse(await sent.json());

    expect(
      (await mailbox(mailboxId).getEmail(messageId))?.attachmentsJson
    ).toEqual([
      expect.objectContaining({
        filename: "notes.txt",
        disposition: "attachment",
      }),
      expect.objectContaining({
        filename: "pixel.png",
        disposition: "inline",
        contentId,
      }),
    ]);
    await runAlarmUntil(
      mailboxId,
      async () => (await held(notes)) === null && (await held(pixel)) === null
    );

    // Discarding a draft deletes its files.
    const discardedId = `drf_${crypto.randomUUID()}`;
    const lone = await upload("lone.txt", "text/plain", "discard me");

    const loneSave = await api(
      `/drafts/${discardedId}?mailboxId=${mailboxId}`,
      {
        method: "PUT",
        body: JSON.stringify({
          expectedVersion: 0,
          kind: "compose",
          attachments: [{ assetId: crypto.randomUUID(), uploadId: lone }],
        }),
      }
    );

    expect(loneSave.status).toBe(200);
    await loneSave.json();
    expect(await held(lone)).not.toBeNull();

    const discarded = await api(
      `/drafts/${discardedId}?mailboxId=${mailboxId}`,
      {
        method: "DELETE",
      }
    );

    expect(discarded.status).toBe(200);
    await discarded.json();
    await runAlarmUntil(mailboxId, async () => (await held(lone)) === null);
  });
  it("lists drafts in Drafts, keeps one reply draft per conversation, and marks its conversation", async () => {
    const { cookie, mailboxId } = await signIn();

    const save = (draftId: string, json: Partial<DraftSave>) =>
      mailApi(cookie, `/drafts/${draftId}?mailboxId=${mailboxId}`, {
        method: "PUT",
        body: JSON.stringify({ expectedVersion: 0, ...json }),
      });

    const sent = z
      .object({ messageId: z.string(), conversationId: z.string() })
      .parse(
        await (
          await mailApi(cookie, "/messages", {
            method: "POST",
            body: JSON.stringify({
              requestId: crypto.randomUUID(),
              mailboxId,
              to: ["friend@example.net"],
              subject: "Lunch",
              bodyText: "Tuesday?",
            }),
          })
        ).json()
      );

    const reply = (draftId: string, bodyText: string) =>
      save(draftId, {
        kind: "reply",
        sourceEmailId: sent.messageId,
        conversationId: sent.conversationId,
        replyMode: "continue",
        to: ["friend@example.net"],
        subject: "Lunch",
        bodyText,
      });

    const first = `drf_${crypto.randomUUID()}`;
    const second = `drf_${crypto.randomUUID()}`;
    const compose = `drf_${crypto.randomUUID()}`;

    for (const response of [
      await reply(first, "Or Wednesday"),
      // Replying to the conversation again replaces the first reply draft.
      await reply(second, "Thursday works too"),
      await save(compose, {
        kind: "compose",
        to: ["boss@example.net"],
        subject: "Report",
        bodyText: "Numbers   attached\nsoon",
      }),
    ]) {
      expect(response.status).toBe(200);
      // oxlint-disable-next-line eslint/no-await-in-loop -- reads each body in turn
      await response.json();
    }

    expect(
      (await mailbox(mailboxId).listDrafts(await adminId())).map(
        (draft) => draft.id
      )
    ).toEqual([compose, second]);

    const { folders } = z
      .object({
        folders: z.array(
          z.looseObject({
            id: z.string(),
            sortOrder: z.number(),
            totalCount: z.number(),
          })
        ),
      })
      .parse(
        await (await mailApi(cookie, `/mailboxes/${mailboxId}/folders`)).json()
      );

    const ids = folders.map((folder) => folder.id);

    expect(ids.indexOf("drafts")).toBe(ids.indexOf("sent") + 1);
    expect(folders.find((folder) => folder.id === "drafts")).toMatchObject({
      systemType: "drafts",
      totalCount: 2,
    });

    const rows = (folder: string) =>
      mailApi(
        cookie,
        `/conversations?mailboxId=${mailboxId}&folder=${folder}&limit=25`
      )
        .then((response) => response.json())
        .then(
          (body) =>
            z
              .object({
                conversations: z.array(
                  z.looseObject({
                    conversationId: z.string(),
                    draft: z.boolean(),
                    draftId: z.string().nullable(),
                  })
                ),
              })
              .parse(body).conversations
        );

    expect(await rows("drafts")).toEqual([
      // A new message is its own row, named by its draft.
      expect.objectContaining({
        conversationId: compose,
        draftId: compose,
        draft: true,
        subject: "Report",
        preview: "Numbers attached soon",
        conversationLabel: "boss@example.net",
      }),
      // A reply draft stands for its conversation.
      expect.objectContaining({
        conversationId: sent.conversationId,
        draftId: second,
        draft: true,
      }),
    ]);

    const inSent = async () =>
      (await rows("sent")).find(
        (row) => row.conversationId === sent.conversationId
      );

    expect(await inSent()).toMatchObject({ draft: true, draftId: null });

    // "Drafts" is taken by the system folder.
    const taken = await mailApi(cookie, `/mailboxes/${mailboxId}/folders`, {
      method: "POST",
      body: JSON.stringify({ name: "drafts" }),
    });

    expect(taken.status).toBe(409);
    await taken.json();

    for (const draftId of [compose, second]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one at a time keeps the cleanup simple
      const discarded = await mailApi(
        cookie,
        `/drafts/${draftId}?mailboxId=${mailboxId}`,
        { method: "DELETE" }
      );

      expect(discarded.status).toBe(200);
      // oxlint-disable-next-line eslint/no-await-in-loop -- reads each body in turn
      await discarded.json();
    }

    expect(await inSent()).toMatchObject({ draft: false });
  });

  it("keeps the signature images it shows as its own files", async () => {
    const { cookie, mailboxId } = await signIn();
    const userId = await adminId();
    const logo = "inline-logo@openworkspace.local";

    const image = await uploadFile(
      cookie,
      mailboxId,
      "logo.png",
      "image/png",
      "png-bytes"
    );

    const signature = (images: { uploadId?: string; contentId: string }[]) =>
      mailApi(cookie, "/signature", {
        method: "PUT",
        body: JSON.stringify({
          html: images.length
            ? `<p>Ana</p><p><img src="cid:${logo}" alt="logo.png"></p>`
            : "<p>Ana</p>",
          text: "Ana",
          images,
          uploadMailboxId: mailboxId,
        }),
      });

    const withLogo = await signature([{ uploadId: image, contentId: logo }]);

    expect(withLogo.status).toBe(200);
    await withLogo.json();

    const draftId = `drf_${crypto.randomUUID()}`;
    const editorHtml = `<p>Hi</p><p><img src="cid:${logo}" data-stored-owner="${userId}"></p>`;

    const save = async (expectedVersion: number) => {
      const response = await mailApi(
        cookie,
        `/drafts/${draftId}?mailboxId=${mailboxId}`,
        {
          method: "PUT",
          body: JSON.stringify({
            expectedVersion,
            kind: "compose",
            bodyText: "Hi",
            bodyHtml: `<p>Hi</p><p><img src="cid:${logo}"></p>`,
            editorHtml,
            storedImages: [{ ownerId: userId, contentId: logo }],
          }),
        }
      );

      expect(response.status).toBe(200);

      return z
        .object({
          draft: z.object({
            attachments: z.array(z.looseObject({ uploadId: z.string() })),
          }),
        })
        .parse(await response.json()).draft.attachments;
    };

    const [copy] = await save(0);

    expect(copy).toMatchObject({
      disposition: "inline",
      contentId: logo,
      contentType: "image/png",
      storedImage: { ownerId: userId, contentId: logo },
    });

    const { uploadId } = required(copy, "the draft keeps the image");

    // Saving again reuses the copy it holds.
    expect(await save(1)).toEqual([expect.objectContaining({ uploadId })]);

    // A new signature without the image leaves the draft's copy in place.
    const withoutLogo = await signature([]);

    expect(withoutLogo.status).toBe(200);
    await withoutLogo.json();
    expect(
      await env.MAIL_STORAGE.head(draftFileKey(mailboxId, userId, uploadId))
    ).not.toBeNull();

    const discarded = await mailApi(
      cookie,
      `/drafts/${draftId}?mailboxId=${mailboxId}`,
      { method: "DELETE" }
    );

    expect(discarded.status).toBe(200);
    await discarded.json();
  });
});
