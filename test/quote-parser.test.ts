import { describe, expect, it } from "vitest";
import { parseReplyText } from "../worker/mail/quote-parser";

describe("email quote parsing", () => {
  it("separates a common attribution block from the new reply", () => {
    expect(parseReplyText([
      "I can ship this today.",
      "",
      "On Tue, Jul 21, 2026 at 10:00 AM Alex wrote:",
      "> Can you ship it?",
    ].join("\r\n"))).toEqual({
      bodyText: "I can ship this today.",
      quotedText: "On Tue, Jul 21, 2026 at 10:00 AM Alex wrote:\n> Can you ship it?",
    });
  });

  it("separates a trailing block of quoted lines without an attribution", () => {
    expect(parseReplyText("New answer\n\n> first line\n> second line")).toEqual({
      bodyText: "New answer",
      quotedText: "> first line\n> second line",
    });
  });

  it("does not treat an isolated greater-than line as an email quote", () => {
    const text = "Use this comparison:\n> 10 requests\nThen collect the result.";
    expect(parseReplyText(text)).toEqual({ bodyText: text, quotedText: null });
  });
});

describe("quote parser cost", () => {
  it("stays linear on crafted input", () => {
    const started = performance.now();
    parseReplyText(Array.from({ length: 200_000 }, (_, i) => (i % 2 ? ">" : "a")).join("\n"));
    parseReplyText(`am ${"schrieb ".repeat(50_000)}`);
    parseReplyText(`from:${" ".repeat(100_000)}a\rb`);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
