import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAI } from "agents/models/ai-sdk";
import type { WorkersAIModelId } from "agents/models/ai-sdk";
import type { LanguageModel } from "ai";
import { z } from "zod";

import type { AiProvider } from "../config/schema";
import { AiConfigurationError } from "./models";

/**
 * The AI SDK providers. Large, and only AI features use them, so models.ts
 * loads this module when it builds a model.
 */

function apiKey(env: Env, secret: string | undefined, providerName: string) {
  if (!secret) return undefined;
  // Secret names are configured at deploy time, so Env's type doesn't know them.
  const parsed = z.object({ [secret]: z.string().min(1) }).safeParse(env);

  if (!parsed.success) {
    throw new AiConfigurationError(
      `Set the ${secret} secret to use the ${providerName} AI provider`
    );
  }

  return parsed.data[secret];
}

export function languageModel(
  env: Env,
  providerName: string,
  provider: AiProvider,
  modelId: string
): LanguageModel {
  switch (provider.type) {
    case "cloudflare": {
      // Mail is private: keep prompts and responses out of AI Gateway logs.
      const ai = createAI({
        binding: env.AI,
        collectLog: false,
        // Without a gateway id the binding uses the account's default gateway.
        id: provider.gateway,
      });

      const routed = cloudflareRoutedModel(modelId);

      // Vendor models keep their own request format; the gateway supplies the
      // key through Unified Billing.
      if (routed) return ai(routed);

      // SAFETY: the typed Workers AI list lags the catalog; the config names
      // the model, and Workers AI rejects one it doesn't serve.
      return ai(modelId as WorkersAIModelId);
    }

    case "openai":
    case "anthropic":
    case "google": {
      const create = {
        openai: createOpenAI,
        anthropic: createAnthropic,
        google: createGoogleGenerativeAI,
      }[provider.type];

      return create({
        baseURL: provider.baseURL,
        headers: provider.headers,
        apiKey: apiKey(env, provider.apiKeyEnv, providerName),
      })(modelId);
    }

    case "openai-compatible": {
      return createOpenAICompatible({
        name: providerName,
        baseURL: provider.baseURL,
        headers: provider.headers,
        apiKey: apiKey(env, provider.apiKeyEnv, providerName),
        supportsStructuredOutputs: true,
      })(modelId);
    }

    default: {
      const unexpected: never = provider;
      throw new AiConfigurationError(
        `Unknown AI provider type for ${providerName}: ${JSON.stringify(unexpected)}`
      );
    }
  }
}

/** A vendor model AI Gateway routes for the cloudflare provider, such as openai/gpt-6-luna. */
function cloudflareRoutedModel(modelId: string) {
  const slash = modelId.indexOf("/");
  const vendor = modelId.slice(0, slash);
  const id = modelId.slice(slash + 1);
  // The gateway replaces this placeholder key with its own.
  const options = { apiKey: "cloudflare" };

  switch (vendor) {
    case "openai": {
      return createOpenAI(options)(id);
    }

    case "anthropic": {
      return createAnthropic(options)(id);
    }

    case "google": {
      return createGoogleGenerativeAI(options)(id);
    }

    default: {
      return null;
    }
  }
}
