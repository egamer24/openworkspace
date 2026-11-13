import type { LanguageModel } from "ai";

import { required } from "../../shared/invariant";
import { workspaceConfig } from "../config";
import type { AiFeature, AiReasoning, WorkspaceConfig } from "../config/schema";

export type AiModel = {
  /** "provider/model" as configured, recorded next to results. */
  id: string;
  model: LanguageModel;
  reasoning: AiReasoning | undefined;
};

export class AiConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiConfigurationError";
  }
}

/** The feature's settings from openworkspace.json, or null when it is off. */
export function aiFeatureSetting(
  feature: AiFeature,
  config: WorkspaceConfig = workspaceConfig()
) {
  const setting = config.ai.features[feature];

  return setting?.enabled ? setting : null;
}

export function aiFeatureEnabled(feature: AiFeature) {
  return aiFeatureSetting(feature) !== null;
}

/** The model a feature runs on, or null when openworkspace.json turns it off. */
export async function aiModel(
  env: Env,
  feature: AiFeature,
  config: WorkspaceConfig = workspaceConfig()
): Promise<AiModel | null> {
  const setting = aiFeatureSetting(feature, config);

  if (!setting) return null;
  const { languageModel } = await import("./providers");

  const provider = required(
    config.ai.providers[setting.provider],
    "The config schema checks that a feature's provider is declared"
  );

  return {
    id: `${setting.provider}/${setting.model}`,
    model: languageModel(env, setting.provider, provider, setting.model),
    reasoning: setting.reasoning,
  };
}
