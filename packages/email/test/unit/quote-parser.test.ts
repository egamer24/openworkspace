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

  it("recognizes attribution lines in each supported language", () => {
    for (const attribution of [
      "On Tue, Jul 21, 2026 at 10:00 AM Alex <alex@example.net> wrote:",
      "Am Di., 21. Juli 2026 um 10:00 Uhr schrieb Alex <alex@example.net>:",
      "Le mar. 21 juil. 2026 à 10:00, Alex <alex@example.net> a écrit :",
      "В вт, 21 июл. 2026 г. в 10:00, Алекс <alex@example.net> написала:",
      "-----Original Message-----",
      "----- Исходное сообщение -----",
    ]) {
      expect(parseReplyText(`Reply\n\n${attribution}\nQuoted`)).toEqual({
        bodyText: "Reply",
        quotedText: `${attribution}\nQuoted`,
      });
    }
  });

  it("separates an Outlook header block only with a following header", () => {
    expect(
      parseReplyText(
        "Reply\n\nFrom: Alex <alex@example.net>\nSent: Tuesday\nOld text"
      )
    ).toEqual({
      bodyText: "Reply",
      quotedText: "From: Alex <alex@example.net>\nSent: Tuesday\nOld text",
    });

    const text = "From: the start of the plan\nwe ship on Tuesday";

    expect(parseReplyText(text)).toEqual({ bodyText: text, quotedText: null });
  });

  it("does not treat lines that only resemble an attribution as one", () => {
    for (const line of [
      "Am schrieb :",
      "On wrote:",
      "Le a écrit :",
      `On ${"x".repeat(300)} wrote:`,
    ]) {
      const text = `Reply\n${line}\nMore`;

      expect(parseReplyText(text)).toEqual({
        bodyText: text,
        quotedText: null,
      });
    }
  });

  it("parses a large body of alternating quoted lines in linear time", () => {
    const lines = Array.from({ length: 200_000 }, (_, index) =>
      index % 2 ? "> quoted" : "a"
    );

    const started = performance.now();
    const parsed = parseReplyText(lines.join("\n"));

    expect(performance.now() - started).toBeLessThan(1000);
    // Only the last five lines are at least 60% quoted.
    expect(parsed.quotedText).toBe("> quoted\na\n> quoted\na\n> quoted");
  });

  it("tests crafted single long lines without backtracking", () => {
    const bodies = [
      `am ${"schrieb ".repeat(100_000)}`,
      `on ${"wrote: ".repeat(100_000)}x`,
      `from:${" ".repeat(200_000)}`,
      `from: ${"x".repeat(200_000)}`,
      `${"> ".repeat(100_000)}\n${"a\n".repeat(1000)}`,
    ];

    const started = performance.now();

    for (const body of bodies) parseReplyText(body);

    expect(performance.now() - started).toBeLessThan(1000);
  });
});
