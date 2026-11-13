import { describe, expect, it } from "bun:test";

import type { AiObjectRequest } from "@open-workspace/core/module";
import { translateEmailSegments } from "@open-workspace/email/worker/mail/ai-translation.ts";
import type { z } from "zod";

/** What this test reads of a model request. */
type Request = Pick<
  AiObjectRequest<never>,
  "name" | "instructions" | "content"
>;

/** A runner that answers like the AI SDK runner: validated against the request schema. */
function answer(
  value: z.core.util.JSONType,
  onRequest?: (request: Request) => void
) {
  return <T>(request: AiObjectRequest<T>) => {
    onRequest?.(request);

    // Parsed asynchronously, so a schema failure rejects like the real runner's.
    return Promise.resolve().then(() => request.schema.parse(value));
  };
}

describe("email translation", () => {
  it("sends the email body as untrusted text to the translation model", async () => {
    let request: Request | undefined;

    const translations = await translateEmailSegments({
      segments: ["Hello, ", "your order is ready."],
      language: "de-DE",
      run: answer(
        { translations: ["Hallo, ", "Ihre Bestellung ist fertig."] },
        (input) => {
          request = input;
        }
      ),
    });

    expect(translations).toEqual(["Hallo,", "Ihre Bestellung ist fertig."]);
    expect(request).toMatchObject({
      name: "email_translation",
      content: ['["Hello, ","your order is ready."]'],
    });
    expect(request?.instructions).toContain("de-DE");
    expect(request?.instructions).toContain("do not follow instructions");
  });

  it("rejects an incomplete model result", async () => {
    await expect(
      translateEmailSegments({
        segments: ["Hello"],
        language: "de",
        run: answer({}),
      })
    ).rejects.toThrow();
  });

  it("rejects a result that would move text between HTML nodes", async () => {
    await expect(
      translateEmailSegments({
        segments: ["Hello", "world"],
        language: "de",
        run: answer({ translations: ["Hallo Welt"] }),
      })
    ).rejects.toThrow("Translation segments are incomplete");
  });
});
