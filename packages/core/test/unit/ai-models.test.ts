import { describe, expect, it } from "bun:test";

import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";

import { aiObjectRunner } from "../../worker/ai/generate.ts";
import {
  AiConfigurationError,
  aiFeatureSetting,
  aiModel,
} from "../../worker/ai/models.ts";
import { workspaceConfigSchema } from "../../worker/config/schema.ts";
import type { WorkspaceConfigInput } from "../../worker/config/schema.ts";

/** What aiModel reads of the bindings: the Workers AI binding and the key secrets providers name. */
type AiBindings = {
  /** Handed to the Workers AI provider, which only stores it; these tests never call the model. */
  AI?: { run: (...args: never[]) => Promise<object> };
  OPENAI_API_KEY?: string;
  LOCAL_LLM_KEY?: string;
};

/** Bindings with only `values`; tests add what they use (no AI keys or Workers AI binding by default). */
function bindings(values: AiBindings = {}) {
  // SAFETY: aiModel reads only env.AI and the secret named by a provider's apiKeyEnv; AiBindings carries both.
  return values as Env;
}

const workersAi = { run: () => Promise.resolve({}) };

const env = bindings();

const mailDomains = ["example.test"];

const config = (ai: WorkspaceConfigInput["ai"]) =>
  workspaceConfigSchema.parse({ mailDomains, ai });

const cloudflare = { type: "cloudflare" } as const;

describe("AI model configuration", () => {
  it("is off when a feature is missing or disabled", async () => {
    expect(aiFeatureSetting("classification", config({}))).toBeNull();

    const configured = config({
      providers: { cloudflare },
      features: {
        translation: { enabled: false },
        classification: {
          enabled: true,
          provider: "cloudflare",
          model: "openai/gpt-6-luna",
          reasoning: "medium",
        },
      },
    });

    expect(aiFeatureSetting("translation", configured)).toBeNull();

    // Gateway catalog models keep the vendor's own model.
    const withBinding = bindings({ AI: workersAi });

    expect(
      await aiModel(withBinding, "classification", configured)
    ).toMatchObject({
      id: "cloudflare/openai/gpt-6-luna",
      reasoning: "medium",
      model: { modelId: "gpt-6-luna" },
    });
  });

  it("runs Workers AI models on the cloudflare provider", async () => {
    const withBinding = bindings({ AI: workersAi });

    const configured = config({
      providers: { cloudflare },
      features: {
        translation: {
          enabled: true,
          provider: "cloudflare",
          model: "@cf/zai-org/glm-4.7-flash",
        },
      },
    });

    expect(
      (await aiModel(withBinding, "translation", configured))?.model
    ).toMatchObject({
      modelId: "@cf/zai-org/glm-4.7-flash",
    });
    expect(
      workspaceConfigSchema.safeParse({
        mailDomains,
        ai: {
          providers: { cloudflare },
          features: {
            translation: {
              enabled: true,
              provider: "cloudflare",
              model: "gpt-5.5",
            },
          },
        },
      }).success
    ).toBe(false);
  });

  it("builds vendor models from keys in Worker secrets", async () => {
    const configured = config({
      providers: { openai: { type: "openai", apiKeyEnv: "OPENAI_API_KEY" } },
      features: {
        classification: { enabled: true, provider: "openai", model: "gpt-5.5" },
      },
    });

    await expect(aiModel(env, "classification", configured)).rejects.toThrow(
      AiConfigurationError
    );

    const model = await aiModel(
      bindings({ OPENAI_API_KEY: "sk-test" }),
      "classification",
      configured
    );

    expect(model?.id).toBe("openai/gpt-5.5");
  });

  it("supports OpenAI-compatible providers", async () => {
    const configured = config({
      providers: {
        local: {
          type: "openai-compatible",
          baseURL: "https://llm.internal.example/v1",
          apiKeyEnv: "LOCAL_LLM_KEY",
        },
      },
      features: {
        translation: { enabled: true, provider: "local", model: "qwen3" },
      },
    });

    const model = await aiModel(
      bindings({ LOCAL_LLM_KEY: "key" }),
      "translation",
      configured
    );

    expect(model?.model).toMatchObject({ modelId: "qwen3" });
  });

  it("rejects features that name an undeclared provider and incomplete providers", () => {
    const undeclared = workspaceConfigSchema.safeParse({
      mailDomains,
      ai: {
        features: {
          translation: { enabled: true, provider: "openai", model: "gpt-5.5" },
        },
      },
    });

    expect(undeclared.error?.issues[0]).toMatchObject({
      path: ["ai", "features", "translation", "provider"],
    });
    expect(
      workspaceConfigSchema.safeParse({
        mailDomains,
        ai: { providers: { openai: { type: "openai" } } },
      }).success
    ).toBe(false);
    expect(
      workspaceConfigSchema.safeParse({
        mailDomains,
        ai: { providers: { local: { type: "openai-compatible" } } },
      }).success
    ).toBe(false);
  });
});

describe("structured AI calls", () => {
  it("returns the validated object and passes reasoning through", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: "text", text: JSON.stringify({ answer: "yes" }) }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      },
    });

    const run = aiObjectRunner({ id: "mock/model", model, reasoning: "low" });

    const result = await run({
      name: "check",
      instructions: "Answer.",
      content: ["Question"],
      schema: z.object({ answer: z.string() }),
      signal: AbortSignal.timeout(5000),
    });

    expect(result).toEqual({ answer: "yes" });
    expect(model.doGenerateCalls[0]).toMatchObject({ reasoning: "low" });
  });
});
