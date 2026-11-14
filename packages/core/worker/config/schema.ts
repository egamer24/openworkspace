import { z } from "zod";

/**
 * The workspace's settings: `OpenWorkspace`'s `mailDomains`, `ai` and `backups` in
 * alchemy.run.ts, checked on deploy and passed to createWorkspace by the
 * generated Worker entry. Secrets never go here; providers read their API keys from the Worker
 * secrets named by apiKeyEnv.
 */

/** A bare domain name, lowercase: a mail domain, or the app's hostname. */
export const domainName = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u,
    "Use a bare domain name such as example.com"
  );

const reasoningLevels = [
  "provider-default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

const providerName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/u, "Use lowercase letters, digits, and dashes");

const secretName = z
  .string()
  .regex(
    /^[A-Z][A-Z0-9_]*$/u,
    "Use the name of a Worker secret, such as OPENAI_API_KEY"
  )
  .describe(
    "Name of the Worker secret that holds the API key (read from the environment or .env when you deploy)"
  );

const headers = z
  .record(z.string(), z.string())
  .optional()
  .describe("Extra HTTP headers sent with every request");

const providerSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z
        .literal("cloudflare")
        .describe(
          "Workers AI (@cf/...) and AI Gateway catalog models (openai/..., anthropic/...) through the AI binding; no key"
        ),
      gateway: z
        .string()
        .min(1)
        .optional()
        .describe("AI Gateway id; the account default when omitted"),
    })
    .strict(),
  ...(["openai", "anthropic", "google"] as const).map((type) =>
    z
      .object({
        type: z.literal(type),
        apiKeyEnv: secretName,
        baseURL: z
          .url()
          .optional()
          .describe("Override the vendor API URL, for example for a proxy"),
        headers,
      })
      .strict()
  ),
  z
    .object({
      type: z
        .literal("openai-compatible")
        .describe("Any API that speaks the OpenAI chat completions protocol"),
      baseURL: z
        .url()
        .describe("API base URL, for example https://openrouter.ai/api/v1"),
      apiKeyEnv: secretName.optional(),
      headers,
    })
    .strict(),
]);

/** Workers AI, AI Gateway dynamic routes, and the vendors the gateway bills for. */
const cloudflareModelId = /^(?:@cf|dynamic|openai|anthropic|google)\/\S+$/u;

const featureSchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }).strict(),
  z
    .object({
      enabled: z.literal(true),
      provider: providerName.describe("A provider declared under ai.providers"),
      model: z
        .string()
        .min(1)
        .describe(
          "Model id as the provider names it, for example gpt-5.5 or @cf/zai-org/glm-4.7-flash"
        ),
      reasoning: z
        .enum(reasoningLevels)
        .optional()
        .describe(
          "How much the model thinks; the provider default when omitted"
        ),
    })
    .strict(),
]);

export const aiProviderTypes = providerSchema.options.map(
  (option) => option.shape.type.value
);

export type AiProvider = z.infer<typeof providerSchema>;

export const aiFeatures = ["classification", "translation"] as const;

export type AiFeature = (typeof aiFeatures)[number];

const aiSchema = z
  .object({
    providers: z
      .record(providerName, providerSchema)
      .default({})
      .describe(
        "Model providers by a name of your choice, referenced from each feature"
      ),
    features: z
      .object({
        classification: featureSchema
          .optional()
          .describe("Spam checks and filing incoming mail into folders"),
        translation: featureSchema
          .optional()
          .describe("Translating messages and attachments on request"),
      })
      .strict()
      .default({})
      .describe("AI features; one that is missing is off"),
  })
  .strict()
  .superRefine((ai, context) => {
    for (const feature of aiFeatures) {
      const setting = ai.features[feature];

      if (!setting?.enabled) continue;
      const provider = ai.providers[setting.provider];

      if (!provider) {
        context.addIssue({
          code: "custom",
          path: ["features", feature, "provider"],
          message: `Declare the ${setting.provider} provider under ai.providers`,
        });
      } else if (
        provider.type === "cloudflare" &&
        !cloudflareModelId.test(setting.model)
      ) {
        context.addIssue({
          code: "custom",
          path: ["features", feature, "model"],
          message:
            "Cloudflare models are @cf/..., dynamic/..., or openai/..., anthropic/..., google/... from the AI Gateway catalog",
        });
      }
    }
  });

export const workspaceConfigSchema = z
  .object({
    /** Mail domains, primary first. The first administrator signs up on one. */
    mailDomains: z
      .array(domainName)
      .min(1, "List at least one mail domain")
      .refine(
        (domains) => new Set(domains).size === domains.length,
        "List each mail domain once"
      )
      .describe("Mail domains, primary first"),
    ai: aiSchema.default({ providers: {}, features: {} }),
    /**
     * Daily snapshots to a bucket of their own (worker/backups/job.ts); off
     * without it. `backups: {}` keeps the defaults.
     */
    backups: z
      .object({
        keepDays: z
          .number()
          .int()
          .min(1)
          .max(366)
          .default(14)
          .describe("Days whose newest snapshot is kept"),
        keepWeeks: z
          .number()
          .int()
          .min(0)
          .max(520)
          .default(8)
          .describe("Weeks whose newest snapshot is kept, besides those days"),
      })
      .strict()
      .optional(),
  })
  .strict();

export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;

export type AiReasoning = (typeof reasoningLevels)[number];

export type WorkspaceConfigInput = z.input<typeof workspaceConfigSchema>;
