import { describe, expect, it } from "vitest";
import { assessSpam } from "../worker/mail/spam-filter";
import {
  learnedSpamProbability,
  learningReasons,
  MAX_MESSAGE_TOKENS,
  messageSpamTokens,
} from "../worker/mail/spam-learning";

describe("spam learning tokenizer", () => {
  it("keeps lowercase words of 3-32 characters, link hosts, and the sender domain", () => {
    const tokens = messageSpamTokens({
      subject: "Cheap PILLS ok",
      bodyText: `Buy now at https://Shop.Pills.example/offer?id=1 or ${"x".repeat(33)}. Ünïcode wörds, ok, pills!`,
      from: "Promo@Mailer.Example",
    });
    expect(tokens).toEqual([
      "from:mailer.example",
      "url:shop.pills.example",
      "subject:cheap",
      "subject:pills",
      "buy",
      "now",
      "https",
      "shop",
      "pills",
      "example",
      "offer",
      "ünïcode",
      "wörds",
    ]);
  });

  it("caps tokens per message", () => {
    const body = Array.from({ length: MAX_MESSAGE_TOKENS * 2 }, (_, index) => `word${index}`).join(" ");
    expect(messageSpamTokens({ subject: "", bodyText: body, from: "" })).toHaveLength(MAX_MESSAGE_TOKENS);
  });
});

describe("spam learning probability", () => {
  const trained = { spam: 20, ham: 20 };

  it("stays silent below the minimum training on either side", () => {
    const spammy = [{ spamCount: 19, hamCount: 0 }];
    expect(learnedSpamProbability(spammy, { spam: 19, ham: 100 })).toBeNull();
    expect(learnedSpamProbability(spammy, { spam: 100, ham: 19 })).toBeNull();
    expect(learnedSpamProbability([], trained)).toBeNull();
    expect(learnedSpamProbability([{ spamCount: 5, hamCount: 5 }], trained)).toBeNull();
  });

  it("leans toward the side the tokens were trained on", () => {
    const spam = learnedSpamProbability([
      { spamCount: 20, hamCount: 0 },
      { spamCount: 15, hamCount: 1 },
    ], trained)!;
    const ham = learnedSpamProbability([{ spamCount: 0, hamCount: 18 }], trained)!;
    expect(spam).toBeGreaterThan(0.95);
    expect(ham).toBeLessThan(0.05);
  });

  it("maps the probability to -20..+35 points with a reason", () => {
    expect(learningReasons(null)).toEqual([]);
    expect(learningReasons(0.5)).toEqual([]);
    expect(learningReasons(1)).toEqual([
      { points: 35, reason: "Similar to messages you marked as spam (p=1.00)" },
    ]);
    expect(learningReasons(0.93)).toEqual([
      { points: 30, reason: "Similar to messages you marked as spam (p=0.93)" },
    ]);
    expect(learningReasons(0)).toEqual([
      { points: -20, reason: "Similar to messages you marked as not spam (p=0.00)" },
    ]);
  });

  it("adds to the local score without overriding the allow list", () => {
    const input = {
      authentication: null,
      relationship: { address: false, domain: false },
      senderList: null,
      from: { address: "a@b.example", name: null },
      recipientCount: 1,
      html: null,
      hasTextPart: true,
      attachments: [],
      learnedProbability: 1,
    };
    const thresholds = { spamThreshold: 30, suspiciousThreshold: 20 };
    expect(assessSpam(input, thresholds)).toMatchObject({ score: 35, verdict: "spam" });
    expect(assessSpam({ ...input, senderList: "allow" }, thresholds).verdict).toBe("clean");
  });
});
