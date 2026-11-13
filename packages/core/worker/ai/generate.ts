import type { z } from "zod";

import type { AiModel } from "./models";

/** One structured-output call: instructions, untrusted text parts, and the expected shape. */
export type AiObjectRequest<T> = {
  name: string;
  instructions: string;
  content: string[];
  schema: z.ZodType<T>;
  signal: AbortSignal;
};

export type AiObjectRunner = <T>(request: AiObjectRequest<T>) => Promise<T>;

export function aiObjectRunner(ai: AiModel): AiObjectRunner {
  return async (request) => {
    // The AI SDK loads with the first call; most requests make none.
    const { generateText, Output } = await import("ai");

    const result = await generateText({
      model: ai.model,
      system: request.instructions,
      messages: [
        {
          role: "user",
          content: request.content.map((text) => ({
            type: "text" as const,
            text,
          })),
        },
      ],
      output: Output.object({ schema: request.schema, name: request.name }),
      // Undefined leaves the provider's default reasoning.
      reasoning: ai.reasoning,
      // Mail is private: OpenAI otherwise keeps responses for later retrieval.
      providerOptions: { openai: { store: false } },
      abortSignal: request.signal,
      maxRetries: 1,
    });

    return request.schema.parse(result.output);
  };
}
