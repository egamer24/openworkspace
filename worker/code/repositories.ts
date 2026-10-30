import { asc, eq } from "drizzle-orm";
import type {
  BranchProtectionRule,
  CodeRepository,
} from "../../shared/code";
import type { Database } from "../db/client";
import {
  codeBranchProtections,
  codeRepositories,
  type CodeRepositoryRecord,
} from "../db/schema";
import { createId } from "../lib/ids";
import {
  artifactsBinding,
  forgetGitUpstream,
  isArtifactsError,
  withArtifactsRepo,
  type ArtifactsBindings,
} from "./artifacts";

export class RepositoryExistsError extends Error {}

export function toCodeRepository(
  record: CodeRepositoryRecord,
  openTasks = 0,
): CodeRepository {
  return {
    name: record.name,
    description: record.description,
    defaultBranch: record.defaultBranch,
    createdAt: record.createdAt.toISOString(),
    openTasks,
  };
}

export async function updateRepository(
  db: Database,
  record: CodeRepositoryRecord,
  patch: { description?: string | null },
) {
  const [updated] = await db
    .update(codeRepositories)
    .set({
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      updatedAt: new Date(),
    })
    .where(eq(codeRepositories.id, record.id))
    .returning();
  return updated!;
}

export async function listRepositories(db: Database) {
  return db
    .select()
    .from(codeRepositories)
    .orderBy(asc(codeRepositories.name));
}

export async function findRepository(db: Database, name: string) {
  const [repository] = await db
    .select()
    .from(codeRepositories)
    .where(eq(codeRepositories.name, name))
    .limit(1);
  return repository ?? null;
}

export async function listBranchProtections(
  db: Database,
  repositoryId: string,
): Promise<BranchProtectionRule[]> {
  return db
    .select({
      pattern: codeBranchProtections.pattern,
      push: codeBranchProtections.push,
      allowDeletion: codeBranchProtections.allowDeletion,
    })
    .from(codeBranchProtections)
    .where(eq(codeBranchProtections.repositoryId, repositoryId))
    .orderBy(asc(codeBranchProtections.pattern));
}

export async function createRepository(
  env: ArtifactsBindings,
  db: Database,
  userId: string,
  input: { name: string; description: string | null; defaultBranch: string },
) {
  if (await findRepository(db, input.name)) {
    throw new RepositoryExistsError("A repository with this name already exists");
  }
  const artifacts = artifactsBinding(env);
  let created: ArtifactsCreateRepoResult;
  try {
    created = await artifacts.create(input.name, {
      ...(input.description ? { description: input.description } : {}),
      setDefaultBranch: input.defaultBranch,
    });
  } catch (error) {
    if (isArtifactsError(error, "ALREADY_EXISTS")) {
      throw new RepositoryExistsError(
        "Git storage with this name already exists",
      );
    }
    throw error;
  }

  const now = new Date();
  const record: CodeRepositoryRecord = {
    id: createId("repo"),
    name: input.name,
    artifactsName: created.name,
    description: input.description,
    defaultBranch: input.defaultBranch,
    createdByUserId: userId,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await db.batch([
      db.insert(codeRepositories).values(record),
      // The default branch starts protected. The integration queue will take
      // over once it exists; until then administrators may push directly.
      db.insert(codeBranchProtections).values({
        id: createId("bpr"),
        repositoryId: record.id,
        pattern: input.defaultBranch,
        push: "admins",
        allowDeletion: false,
        createdAt: now,
        updatedAt: now,
      }),
    ]);
  } catch (error) {
    await artifacts.delete(created.name).catch((cleanupError: unknown) => {
      console.error("Could not remove orphaned Artifacts repository", cleanupError);
    });
    throw error;
  }

  // Clients never use the creation token; the proxy mints its own.
  try {
    await withArtifactsRepo(env, created.name, (repo) => repo.revokeToken(created.token));
  } catch (error) {
    console.error("Could not revoke initial Artifacts token", error);
  }
  return record;
}

export async function deleteRepository(
  env: ArtifactsBindings,
  db: Database,
  record: CodeRepositoryRecord,
) {
  // Remove storage first: a retry after a partial failure finds the row and
  // completes the deletion, while the reverse order would orphan Git data.
  await artifactsBinding(env).delete(record.artifactsName);
  forgetGitUpstream(record.artifactsName);
  await db.delete(codeRepositories).where(eq(codeRepositories.id, record.id));
}

export async function replaceBranchProtections(
  db: Database,
  repositoryId: string,
  rules: BranchProtectionRule[],
) {
  const now = new Date();
  await db.batch([
    db
      .delete(codeBranchProtections)
      .where(eq(codeBranchProtections.repositoryId, repositoryId)),
    ...rules.map((rule) =>
      db.insert(codeBranchProtections).values({
        id: createId("bpr"),
        repositoryId,
        ...rule,
        createdAt: now,
        updatedAt: now,
      })
    ),
  ]);
}
