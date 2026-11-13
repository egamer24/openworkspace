import { workspaceConfigSchema } from "./schema";
import type { WorkspaceConfig, WorkspaceConfigInput } from "./schema";

let current: WorkspaceConfig | null = null;

/** Validates the options passed to createWorkspace and makes them current. */
export function configureWorkspace(input: WorkspaceConfigInput) {
  const parsed = workspaceConfigSchema.safeParse(input);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(
        (issue) => `  ${issue.path.join(".") || "(options)"}: ${issue.message}`
      )
      .join("\n");

    throw new Error(`OpenWorkspace options are invalid:\n${issues}`);
  }

  current = parsed.data;

  return current;
}

/** The workspace's configuration, from createWorkspace. */
export function workspaceConfig(): WorkspaceConfig {
  if (!current) {
    throw new Error("createWorkspace has not configured the workspace");
  }

  return current;
}
