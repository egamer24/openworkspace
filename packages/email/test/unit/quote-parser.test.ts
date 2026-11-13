import { describe, expect, it } from "bun:test";

import { parseReplyText } from "@open-workspace/email/worker/mail/quote-parser.ts";

describe("email quote parsing", () => {
  it("separates a common attribution block from the new reply", () => {
    expect(
      parseReplyText(
        [
          "I can ship this today.",
          "",
          "On Tue, Jul 21, 2026 at 10:00 AM Alex wrote:",
          "> Can you ship it?",
        ].join("\r\n")
      )
    ).toEqual({
      bodyText: "I can ship this today.",
      quotedText:
        "On Tue, Jul 21, 2026 at 10:00 AM Alex wrote:\n> Can you ship it?",
    });
  });

  it("separates a trailing block of quoted lines without an attribution", () => {
    expect(parseReplyText("New answer\n\n> first line\n> second line")).toEqual(
      {
        bodyText: "New answer",
        quotedText: "> first line\n> second line",
      }
    );
  });

  it("does not treat an isolated greater-than line as an email quote", () => {
    const text =
      "Use this comparison:\n> 10 requests\nThen collect the result.";

    expect(parseReplyText(text)).toEqual({ bodyText: text, quotedText: null });
  });
});
