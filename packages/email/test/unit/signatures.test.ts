import { describe, expect, it } from "bun:test";

import { referencedStoredImages } from "../../worker/mail/rich-content";
import {
  appendSignature,
  signatureOwner,
  withSenderName,
} from "../../worker/mail/signatures";
import type { Signature } from "../../worker/mail/signatures";

const logo = {
  contentId: "inline-logo@openworkspace.local",
  filename: "logo.png",
  contentType: "image/png",
  size: 10,
};

const signature: Signature & { ownerId: string } = {
  ownerId: "usr_a",
  html: '<p>{name}</p><p>Support team <img src="cid:inline-logo@openworkspace.local"></p>',
  text: "{name}\n\nSupport team logo.png",
  images: [logo],
  useOnNew: true,
  useOnReply: false,
};

describe("signatureOwner", () => {
  it("uses a team address's own signature for everyone", () => {
    expect(
      signatureOwner({ id: "mbx_team", ownerUserId: null }, "usr_a")
    ).toEqual({
      mailboxId: "mbx_team",
    });
  });

  it("uses the sender's personal signature in their own mailbox", () => {
    expect(
      signatureOwner({ id: "mbx_a", ownerUserId: "usr_a" }, "usr_a")
    ).toEqual({
      userId: "usr_a",
    });
  });

  it("adds none from someone else's mailbox", () => {
    expect(
      signatureOwner({ id: "mbx_b", ownerUserId: "usr_b" }, "usr_a")
    ).toBeNull();
  });
});

describe("withSenderName", () => {
  it("fills in {name}, escaped in HTML", () => {
    expect(withSenderName(signature, "Ana <Ops>")).toEqual({
      html: '<p>Ana &lt;Ops&gt;</p><p>Support team <img src="cid:inline-logo@openworkspace.local"></p>',
      text: "Ana <Ops>\n\nSupport team logo.png",
    });
  });
});

describe("appendSignature", () => {
  it("appends text, HTML and the images it shows to new messages", () => {
    expect(
      appendSignature(
        { bodyText: "Hi\n", bodyHtml: "<p>Hi</p>" },
        signature,
        "new",
        "Ana"
      )
    ).toEqual({
      bodyText: "Hi\n\nAna\n\nSupport team logo.png",
      bodyHtml:
        '<p>Hi</p><div data-rich-content><br><p>Ana</p><p>Support team <img src="cid:inline-logo@openworkspace.local"></p></div>',
      inlineImages: [
        { ...logo, r2Key: "signatures/usr_a/inline-logo@openworkspace.local" },
      ],
    });
  });

  it("gives a text-only body an HTML part", () => {
    expect(
      appendSignature({ bodyText: "a < b" }, signature, "new", "Ana").bodyHtml
    ).toStartWith(
      '<div style="white-space:pre-wrap">a &lt; b</div><div data-rich-content>'
    );
  });

  it("follows the replies switch, and leaves the message alone without a signature", () => {
    const message = { bodyText: "Hi" };

    expect(appendSignature(message, signature, "reply", "Ana")).toEqual({
      bodyText: "Hi",
      inlineImages: [],
    });
    expect(appendSignature(message, null, "new", "Ana")).toEqual({
      bodyText: "Hi",
      inlineImages: [],
    });
  });

  it("sends only the images still in the HTML", () => {
    expect(
      appendSignature(
        { bodyText: "Hi" },
        { ...signature, html: "<p>{name}</p>" },
        "new",
        "Ana"
      ).inlineImages
    ).toEqual([]);
  });
});

describe("referencedStoredImages", () => {
  const sources = [
    { ownerId: "usr_a", prefix: "signatures/usr_a/", images: [logo] },
  ];

  it("sends a saved image the body refers to from its stored object", () => {
    expect(
      referencedStoredImages(
        [{ ownerId: "usr_a", contentId: logo.contentId }],
        sources
      )
    ).toEqual([
      { ...logo, r2Key: "signatures/usr_a/inline-logo@openworkspace.local" },
    ]);
  });

  it("refuses an image of content the sender may not use", () => {
    expect(() =>
      referencedStoredImages(
        [{ ownerId: "usr_b", contentId: logo.contentId }],
        sources
      )
    ).toThrow("Inline image was not found");
    expect(() =>
      referencedStoredImages(
        [{ ownerId: "usr_a", contentId: "other@openworkspace.local" }],
        sources
      )
    ).toThrow("Inline image was not found");
  });
});
