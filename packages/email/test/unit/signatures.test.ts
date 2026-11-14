import { describe, expect, it } from "bun:test";

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

const signature: Signature = {
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
        '<p>Hi</p><div data-signature><br><p>Ana</p><p>Support team <img src="cid:inline-logo@openworkspace.local"></p></div>',
      signatureImages: [logo],
    });
  });

  it("gives a text-only body an HTML part", () => {
    expect(
      appendSignature({ bodyText: "a < b" }, signature, "new", "Ana").bodyHtml
    ).toStartWith(
      '<div style="white-space:pre-wrap">a &lt; b</div><div data-signature>'
    );
  });

  it("follows the replies switch, and leaves the message alone without a signature", () => {
    const message = { bodyText: "Hi" };

    expect(appendSignature(message, signature, "reply", "Ana")).toEqual({
      bodyText: "Hi",
      signatureImages: [],
    });
    expect(appendSignature(message, null, "new", "Ana")).toEqual({
      bodyText: "Hi",
      signatureImages: [],
    });
  });

  it("sends only the images still in the HTML", () => {
    expect(
      appendSignature(
        { bodyText: "Hi" },
        { ...signature, html: "<p>{name}</p>" },
        "new",
        "Ana"
      ).signatureImages
    ).toEqual([]);
  });
});
