import { describe, expect, it } from "bun:test";

import {
  recipientAddresses,
  recipientField,
} from "@open-workspace/email/src/mail/composer-recipients.ts";
import type { ComposerAsset } from "@open-workspace/email/src/mail/composer-session.ts";
import {
  draftAttachments,
  holdsOnlyInitialContent,
  restoredComposerAssets,
} from "@open-workspace/email/src/mail/draft-attachments.ts";
import {
  composeSchema,
  draftIdSchema,
  saveDraftSchema,
} from "@open-workspace/email/worker/mail/schemas.ts";

describe("draft saves", () => {
  it("keeps addresses as typed, since a draft may be half-written", () => {
    const parsed = saveDraftSchema.parse({
      expectedVersion: 0,
      kind: "compose",
      to: ["not-an-address-yet"],
    });

    expect(parsed).toMatchObject({
      to: ["not-an-address-yet"],
      cc: [],
      subject: "",
      bodyHtml: null,
    });
  });

  it("needs the message for replies and forwards, and the mode for replies", () => {
    expect(
      saveDraftSchema.safeParse({ expectedVersion: 0, kind: "forward" }).success
    ).toBe(false);
    expect(
      saveDraftSchema.safeParse({
        expectedVersion: 0,
        kind: "reply",
        sourceEmailId: "msg_1",
      }).success
    ).toBe(false);
    expect(
      saveDraftSchema.safeParse({
        expectedVersion: 0,
        kind: "reply",
        sourceEmailId: "msg_1",
        replyMode: "reply_all",
      }).success
    ).toBe(true);
  });

  it("accepts only draft ids the composer makes", () => {
    expect(draftIdSchema.safeParse(`drf_${crypto.randomUUID()}`).success).toBe(
      true
    );
    expect(draftIdSchema.safeParse("drf_../x").success).toBe(false);
    expect(draftIdSchema.safeParse("upl_12345678").success).toBe(false);
  });

  it("lets a send name the draft it came from", () => {
    const draftId = `drf_${crypto.randomUUID()}`;

    expect(
      composeSchema.parse({
        requestId: crypto.randomUUID(),
        mailboxId: "mbx_1",
        draftId,
        to: ["friend@example.net"],
        bodyText: "Hi",
      }).draftId
    ).toBe(draftId);
  });
});

describe("restoring draft recipients", () => {
  it("round-trips addresses through a recipient field", () => {
    const field = recipientField(["a@example.net", "b@example.net"]);

    expect(recipientAddresses(field)).toEqual([
      "a@example.net",
      "b@example.net",
    ]);
    expect(recipientAddresses({ ...field, input: "c@example.net" })).toEqual([
      "a@example.net",
      "b@example.net",
      "c@example.net",
    ]);
  });
});

describe("draft attachments", () => {
  const asset = (overrides: Partial<ComposerAsset>): ComposerAsset => ({
    id: crypto.randomUUID(),
    uploadId: `upl_${"a".repeat(32)}`,
    filename: "file.txt",
    contentType: "text/plain",
    size: 10,
    intent: "attachment",
    contentId: null,
    previewUrl: null,
    status: "uploaded",
    error: null,
    ...overrides,
  });

  it("keeps finished uploads only, as the save schema takes them", () => {
    const image = asset({
      intent: "inline",
      contentType: "image/png",
      contentId: "inline-1@openworkspace.local",
      uploadId: `upl_${"b".repeat(32)}`,
    });

    const file = asset({});

    const kept = draftAttachments([
      file,
      image,
      asset({ status: "uploading", uploadId: null }),
    ]);

    expect(kept).toEqual([
      {
        assetId: file.id,
        uploadId: file.uploadId ?? "",
        disposition: "attachment",
        contentId: undefined,
      },
      {
        assetId: image.id,
        uploadId: image.uploadId ?? "",
        disposition: "inline",
        contentId: image.contentId ?? "",
      },
    ]);
    expect(
      saveDraftSchema.safeParse({
        expectedVersion: 0,
        kind: "compose",
        attachments: kept,
      }).success
    ).toBe(true);
  });

  it("rebuilds uploaded assets, with a preview only for inline images that stay inline", () => {
    const file = {
      assetId: crypto.randomUUID(),
      uploadId: `upl_${"c".repeat(32)}`,
      disposition: "inline" as const,
      contentId: "inline-2@openworkspace.local",
      filename: "photo.png",
      contentType: "image/png",
      size: 2048,
    };

    const [image, huge, plain] = restoredComposerAssets("mbx_1", {
      attachments: [
        file,
        { ...file, assetId: crypto.randomUUID(), size: 50_000_000 },
        {
          ...file,
          assetId: crypto.randomUUID(),
          disposition: "attachment",
          contentId: null,
        },
      ],
    });

    expect(image).toMatchObject({
      id: file.assetId,
      uploadId: file.uploadId,
      intent: "inline",
      status: "uploaded",
      previewUrl: `/api/mail/drafts/files/${file.uploadId}?mailboxId=mbx_1`,
    });
    expect(huge?.previewUrl).toBeNull();
    expect(plain?.previewUrl).toBeNull();
    expect(restoredComposerAssets("mbx_1", undefined)).toEqual([]);
  });
});

describe("an untouched composer", () => {
  const signature = "Best,\n\nAda Lovelace";

  it("holds only the signature it opened with, however it is spaced", () => {
    expect(
      holdsOnlyInitialContent(
        { bodyText: "\n\nBest,\nAda   Lovelace\n", inlineAssetIds: [] },
        signature,
        0
      )
    ).toBe(true);
  });

  it("is touched by text, an inline image or an attachment", () => {
    const content = { bodyText: signature, inlineAssetIds: [] };

    expect(
      holdsOnlyInitialContent(
        { ...content, bodyText: `Hi\n\n${signature}` },
        signature,
        0
      )
    ).toBe(false);
    expect(
      holdsOnlyInitialContent(
        { ...content, inlineAssetIds: ["asset"] },
        signature,
        0
      )
    ).toBe(false);
    expect(holdsOnlyInitialContent(content, signature, 1)).toBe(false);
  });
});
