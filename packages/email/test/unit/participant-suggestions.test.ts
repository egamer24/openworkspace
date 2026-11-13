import { describe, expect, it } from "bun:test";

import { suggestParticipants } from "@open-workspace/email/worker/mail/participants.ts";

describe("recipient suggestions", () => {
  it("prefers recent participants, matches names, and excludes the mailbox", () => {
    const suggestions = suggestParticipants(
      [
        {
          fromJson: [{ address: "maya@Example.NET", name: "Maya Chen" }],
          toJson: [{ address: "me@example.test", name: null }],
          ccJson: [],
          bccJson: [{ address: "hidden@example.net", name: "Hidden Person" }],
        },
        {
          fromJson: [
            { address: "older@example.net", name: "Maya Older" },
            { address: "Maya@example.net", name: "Maya Case" },
          ],
          toJson: [{ address: "maya@example.net", name: "Duplicate Maya" }],
          ccJson: [],
          bccJson: [],
        },
      ],
      "me@example.test",
      "maya",
      8
    );

    expect(suggestions).toEqual([
      { address: "maya@example.net", name: "Maya Chen" },
      { address: "older@example.net", name: "Maya Older" },
      { address: "Maya@example.net", name: "Maya Case" },
    ]);
  });

  it("includes recipients previously used only in Bcc", () => {
    const suggestions = suggestParticipants(
      [
        {
          fromJson: [],
          toJson: [],
          ccJson: [],
          bccJson: [{ address: "hidden@example.net", name: "Hidden Person" }],
        },
      ],
      "me@example.test",
      "hidden",
      8
    );

    expect(suggestions).toEqual([
      { address: "hidden@example.net", name: "Hidden Person" },
    ]);
  });
});
