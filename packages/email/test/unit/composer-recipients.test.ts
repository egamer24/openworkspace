import { describe, expect, it } from "bun:test";

import {
  normalizeComposerRecipient,
  parseComposerRecipients,
  recipientsWithPendingInput,
  validateComposerRecipients,
} from "@open-workspace/email/src/mail/composer-recipients.ts";

describe("composer recipient parsing", () => {
  it("reports mixed invalid input without dropping the valid addresses", () => {
    expect(
      parseComposerRecipients(
        "Ada <Ada@Example.COM>, broken-address; bob@example.net"
      )
    ).toEqual({
      recipients: [
        { address: "Ada@example.com", name: "Ada" },
        { address: "bob@example.net", name: null },
      ],
      invalidParts: ["broken-address"],
    });
  });

  it("preserves case-sensitive local parts", () => {
    expect(
      recipientsWithPendingInput({
        recipients: [],
        input: "Person@Example.NET, person@example.net",
      }).map((recipient) => recipient.address)
    ).toEqual(["Person@example.net", "person@example.net"]);
  });

  it("keeps quoted display-name separators and rejects server-invalid domains", () => {
    expect(
      parseComposerRecipients('"Doe, Jane" <Jane@Example.COM>; a@b')
    ).toEqual({
      recipients: [
        {
          address: "Jane@example.com",
          name: "Doe, Jane",
        },
      ],
      invalidParts: ["a@b"],
    });
  });

  it("validates suggestions and Reply-to through the same email rules", () => {
    expect(
      normalizeComposerRecipient({
        address: "suggestion-without-domain",
        name: "Broken",
      })
    ).toBeNull();
    expect(
      validateComposerRecipients({
        to: {
          recipients: [{ address: "person@example.net", name: null }],
          input: "",
        },
        cc: { recipients: [], input: "" },
        bcc: { recipients: [], input: "" },
        replyTo: "broken-reply-to",
      }).error
    ).toBe("Check the Reply-to address");
  });

  it("rejects domain labels that end in a hyphen", () => {
    expect(
      normalizeComposerRecipient({
        address: "person@invalid-.example",
        name: null,
      })
    ).toBeNull();
  });
});
