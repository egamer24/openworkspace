import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { requireAdmin, requireAuth } from "../auth/middleware";
import { createDb } from "../db/client";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import { z } from "zod";
import { openTaskCounts } from "../tasks/service";
import { taskRoutes } from "../tasks/routes";
import { ArtifactsUnavailableError, withArtifactsRepo } from "./artifacts";
import {
  CodeNotFoundError,
  compareCode,
  listCodeBranches,
  listCodeCommits,
  listCodeFiles,
  listCodeTags,
  listPathCommits,
  listRefs,
  readCodeBlob,
  readCodeCommit,
  readCodeRaw,
  readCodeTree,
  readEntryCommits,
  resolveCommit,
} from "./browse";
import { readLanguages } from "./languages";
import { ZERO_OID } from "./pkt-line";
import { authorizeRefUpdates, matchingRules } from "./ref-policy";
import { RefUpdateRejectedError, updateRef } from "./ref-update";
import {
  createRepository,
  deleteRepository,
  findRepository,
  listBranchProtections,
  listRepositories,
  replaceBranchProtections,
  RepositoryExistsError,
  toCodeRepository,
  updateRepository,
} from "./repositories";
import {
  branchNameSchema,
  branchProtectionsSchema,
  createBranchSchema,
  createRepositorySchema,
  updateRepositorySchema,
} from "./schemas";

const browseQuerySchema = z.object({
  ref: z.string().trim().min(1).max(255).optional(),
  path: z.string().max(4096).default(""),
});

const commitsQuerySchema = z.object({
  ref: z.string().trim().min(1).max(255).optional(),
  path: z.string().max(4096).default(""),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

const compareQuerySchema = z.object({
  base: z.string().trim().min(1).max(255),
  head: z.string().trim().min(1).max(255),
  direct: z.enum(["1", "0"]).optional(),
});

const refQuerySchema = z.object({
  ref: z.string().trim().min(1).max(255).optional(),
});

const rawQuerySchema = browseQuerySchema.extend({
  inline: z.enum(["1"]).optional(),
});

/** Images that may render inline; everything else downloads. */
const INLINE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};

const globalFetch = (input: string, init?: RequestInit) => fetch(input, init);

function remoteUrl(request: Request, name: string) {
  return `${new URL(request.url).origin}/${name}.git`;
}

export const codeRoutes = new Hono<AppEnv>()
  .use("*", requireAuth)
  .get("/repos", async (c) => {
    const db = createDb(c.env.DB);
    const [repositories, counts] = await Promise.all([
      listRepositories(db),
      openTaskCounts(db),
    ]);
    return c.json({
      ok: true as const,
      repositories: repositories.map((repository) => ({
        ...toCodeRepository(repository, counts.get(repository.id) ?? 0),
        remote: remoteUrl(c.req.raw, repository.name),
      })),
    });
  })
  .post("/repos", zValidator("json", createRepositorySchema), async (c) => {
    try {
      const repository = await createRepository(
        c.env,
        createDb(c.env.DB),
        c.get("user").id,
        c.req.valid("json"),
      );
      return c.json({
        ok: true as const,
        repository: {
          ...toCodeRepository(repository),
          remote: remoteUrl(c.req.raw, repository.name),
        },
      }, 201);
    } catch (error) {
      if (error instanceof RepositoryExistsError) {
        return apiError(c, 409, "CONFLICT", error.message);
      }
      if (error instanceof ArtifactsUnavailableError) {
        return apiError(c, 503, "UNAVAILABLE", error.message);
      }
      throw error;
    }
  })
  .get("/repos/:name", async (c) => {
    const db = createDb(c.env.DB);
    const repository = await findRepository(db, c.req.param("name"));
    if (!repository) return apiError(c, 404, "NOT_FOUND", "Repository not found");
    const counts = await openTaskCounts(db);
    return c.json({
      ok: true as const,
      repository: {
        ...toCodeRepository(repository, counts.get(repository.id) ?? 0),
        remote: remoteUrl(c.req.raw, repository.name),
      },
      branchProtections: await listBranchProtections(db, repository.id),
    });
  })
  .patch("/repos/:name", requireAdmin, zValidator("json", updateRepositorySchema), async (c) => {
    const db = createDb(c.env.DB);
    const repository = await findRepository(db, c.req.param("name"));
    if (!repository) return apiError(c, 404, "NOT_FOUND", "Repository not found");
    const updated = await updateRepository(db, repository, c.req.valid("json"));
    return c.json({
      ok: true as const,
      repository: {
        ...toCodeRepository(updated),
        remote: remoteUrl(c.req.raw, updated.name),
      },
    });
  })
  .delete("/repos/:name", requireAdmin, async (c) => {
    const db = createDb(c.env.DB);
    const repository = await findRepository(db, c.req.param("name"));
    if (!repository) return apiError(c, 404, "NOT_FOUND", "Repository not found");
    try {
      await deleteRepository(c.env, db, repository);
    } catch (error) {
      if (error instanceof ArtifactsUnavailableError) {
        return apiError(c, 503, "UNAVAILABLE", error.message);
      }
      throw error;
    }
    return c.json({ ok: true as const });
  })
  .put(
    "/repos/:name/branch-protections",
    requireAdmin,
    zValidator("json", branchProtectionsSchema),
    async (c) => {
      const db = createDb(c.env.DB);
      const repository = await findRepository(db, c.req.param("name"));
      if (!repository) {
        return apiError(c, 404, "NOT_FOUND", "Repository not found");
      }
      await replaceBranchProtections(db, repository.id, c.req.valid("json").rules);
      return c.json({
        ok: true as const,
        branchProtections: await listBranchProtections(db, repository.id),
      });
    },
  )
  .get("/repos/:name/refs", async (c) => {
    const repository = await findRepository(createDb(c.env.DB), c.req.param("name"));
    if (!repository) return apiError(c, 404, "NOT_FOUND", "Repository not found");
    return c.json({
      ok: true as const,
      refs: await listRefs(
        c.env,
        repository.artifactsName,
        repository.defaultBranch,
        globalFetch,
      ),
    });
  })
  .get("/repos/:name/tree", zValidator("query", browseQuerySchema), async (c) => {
    const repository = await findRepository(createDb(c.env.DB), c.req.param("name"));
    if (!repository) return apiError(c, 404, "NOT_FOUND", "Repository not found");
    const { ref, path } = c.req.valid("query");
    try {
      return c.json({
        ok: true as const,
        tree: await readCodeTree(
          c.env,
          repository.artifactsName,
          ref ?? repository.defaultBranch,
          path,
        ),
      });
    } catch (error) {
      if (error instanceof CodeNotFoundError) {
        return apiError(c, 404, "NOT_FOUND", error.message);
      }
      throw error;
    }
  })
  .get("/repos/:name/blob", zValidator("query", browseQuerySchema), async (c) => {
    const repository = await findRepository(createDb(c.env.DB), c.req.param("name"));
    if (!repository) return apiError(c, 404, "NOT_FOUND", "Repository not found");
    const { ref, path } = c.req.valid("query");
    try {
      return c.json({
        ok: true as const,
        blob: await readCodeBlob(
          c.env,
          repository.artifactsName,
          ref ?? repository.defaultBranch,
          path,
        ),
      });
    } catch (error) {
      if (error instanceof CodeNotFoundError) {
        return apiError(c, 404, "NOT_FOUND", error.message);
      }
      throw error;
    }
  })
  .get("/repos/:name/raw", zValidator("query", rawQuerySchema), async (c) => {
    const repository = await findRepository(createDb(c.env.DB), c.req.param("name"));
    if (!repository) return apiError(c, 404, "NOT_FOUND", "Repository not found");
    const { ref, path, inline } = c.req.valid("query");
    try {
      const file = await readCodeRaw(
        c.env,
        repository.artifactsName,
        ref ?? repository.defaultBranch,
        path,
      );
      const name = path.split("/").at(-1) ?? "file";
      const extension = name.includes(".") ? name.split(".").at(-1)!.toLowerCase() : "";
      const imageType = inline ? INLINE_TYPES[extension] : undefined;
      return new Response(file.stream(), {
        headers: {
          // Never render repository content as active HTML on our origin:
          // only known image types display inline, inside a sandbox that
          // also disables scripts in SVG.
          "content-type": imageType ?? "application/octet-stream",
          "content-disposition": `${imageType ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
          "content-security-policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
          "x-content-type-options": "nosniff",
          "cache-control": "private, max-age=60",
        },
      });
    } catch (error) {
      if (error instanceof CodeNotFoundError) {
        return apiError(c, 404, "NOT_FOUND", error.message);
      }
      throw error;
    }
  })
  .get("/repos/:name/commits", zValidator("query", commitsQuerySchema), async (c) => {
    const repository = await findRepository(createDb(c.env.DB), c.req.param("name"));
    if (!repository) return apiError(c, 404, "NOT_FOUND", "Repository not found");
    const { ref, path, limit, offset } = c.req.valid("query");
    const target = ref ?? repository.defaultBranch;
    try {
      if (path) {
        return c.json({
          ok: true as const,
          ...await listPathCommits(c.env, repository.artifactsName, target, path, limit, offset),
        });
      }
      const page = await listCodeCommits(c.env, repository.artifactsName, target, limit, offset);
      return c.json({
        ok: true as const,
        commits: page.commits,
        nextOffset: page.hasMore ? offset + limit : null,
      });
    } catch (error) {
      if (error instanceof CodeNotFoundError) {
        return apiError(c, 404, "NOT_FOUND", error.message);
      }
      throw error;
    }
  })
  .get("/repos/:name/commits/:hash", async (c) => {
    const repository = await findRepository(createDb(c.env.DB), c.req.param("name"));
    if (!repository) return apiError(c, 404, "NOT_FOUND", "Repository not found");
    try {
      return c.json({
        ok: true as const,
        ...await readCodeCommit(c.env, repository.artifactsName, c.req.param("hash")),
      });
    } catch (error) {
      if (error instanceof CodeNotFoundError) {
        return apiError(c, 404, "NOT_FOUND", error.message);
      }
      throw error;
    }
  })
  .get("/repos/:name/branches", async (c) => {
    const db = createDb(c.env.DB);
    const repository = await findRepository(db, c.req.param("name"));
    if (!repository) return apiError(c, 404, "NOT_FOUND", "Repository not found");
    const [refs, rules] = await Promise.all([
      listRefs(c.env, repository.artifactsName, repository.defaultBranch, globalFetch),
      listBranchProtections(db, repository.id),
    ]);
    return c.json({
      ok: true as const,
      defaultBranch: refs.defaultBranch,
      branches: await listCodeBranches(
        c.env,
        repository.artifactsName,
        refs,
        (branch) => matchingRules(branch, rules).length > 0,
      ),
    });
  })
  .post("/repos/:name/branches", zValidator("json", createBranchSchema), async (c) => {
    const db = createDb(c.env.DB);
    const repository = await findRepository(db, c.req.param("name"));
    if (!repository) return apiError(c, 404, "NOT_FOUND", "Repository not found");
    const { name, from } = c.req.valid("json");
    const commit = await withArtifactsRepo(
      c.env,
      repository.artifactsName,
      (repo) => resolveCommit(repo, from),
    );
    if (!commit) return apiError(c, 422, "BAD_REQUEST", `${from} not found`);
    const update = { ref: `refs/heads/${name}`, oldOid: "0".repeat(40), newOid: commit.hash };
    const denied = authorizeRefUpdates(
      c.get("user"),
      [update],
      await listBranchProtections(db, repository.id),
    ).get(update.ref);
    if (denied) return apiError(c, 403, "FORBIDDEN", denied);
    try {
      await updateRef(c.env, repository.artifactsName, update, globalFetch);
    } catch (error) {
      if (error instanceof RefUpdateRejectedError) {
        return apiError(c, 409, "CONFLICT", `Branch ${name} already exists`);
      }
      throw error;
    }
    return c.json({ ok: true as const, branch: { name, hash: commit.hash } }, 201);
  })
  .delete(
    "/repos/:name/branches",
    zValidator("query", z.object({ branch: branchNameSchema })),
    async (c) => {
      const db = createDb(c.env.DB);
      const repository = await findRepository(db, c.req.param("name"));
      if (!repository) return apiError(c, 404, "NOT_FOUND", "Repository not found");
      const { branch } = c.req.valid("query");
      if (branch === repository.defaultBranch) {
        return apiError(c, 409, "CONFLICT", "The default branch cannot be deleted");
      }
      const refs = await listRefs(
        c.env,
        repository.artifactsName,
        repository.defaultBranch,
        globalFetch,
      );
      const current = refs.branches.find((item) => item.name === branch);
      if (!current) return apiError(c, 404, "NOT_FOUND", "Branch not found");
      const update = {
        ref: `refs/heads/${branch}`,
        oldOid: current.hash,
        newOid: "0".repeat(40),
      };
      const denied = authorizeRefUpdates(
        c.get("user"),
        [update],
        await listBranchProtections(db, repository.id),
      ).get(update.ref);
      if (denied) return apiError(c, 403, "FORBIDDEN", denied);
      try {
        await updateRef(c.env, repository.artifactsName, update, globalFetch);
      } catch (error) {
        if (error instanceof RefUpdateRejectedError) {
          return apiError(c, 409, "CONFLICT", "The branch moved; reload and try again");
        }
        throw error;
      }
      return c.json({ ok: true as const, deleted: !ZERO_OID.test(current.hash) });
    },
  )
  .get("/repos/:name/tags", async (c) => {
    const repository = await findRepository(createDb(c.env.DB), c.req.param("name"));
    if (!repository) return apiError(c, 404, "NOT_FOUND", "Repository not found");
    const refs = await listRefs(
      c.env,
      repository.artifactsName,
      repository.defaultBranch,
      globalFetch,
    );
    return c.json({
      ok: true as const,
      tags: await listCodeTags(c.env, repository.artifactsName, refs),
    });
  })
  .get("/repos/:name/compare", zValidator("query", compareQuerySchema), async (c) => {
    const repository = await findRepository(createDb(c.env.DB), c.req.param("name"));
    if (!repository) return apiError(c, 404, "NOT_FOUND", "Repository not found");
    const { base, head, direct } = c.req.valid("query");
    try {
      return c.json({
        ok: true as const,
        comparison: await compareCode(c.env, repository.artifactsName, base, head, {
          direct: direct === "1",
        }),
      });
    } catch (error) {
      if (error instanceof CodeNotFoundError) {
        return apiError(c, 404, "NOT_FOUND", error.message);
      }
      throw error;
    }
  })
  .get("/repos/:name/entry-commits", zValidator("query", browseQuerySchema), async (c) => {
    const repository = await findRepository(createDb(c.env.DB), c.req.param("name"));
    if (!repository) return apiError(c, 404, "NOT_FOUND", "Repository not found");
    const { ref, path } = c.req.valid("query");
    try {
      return c.json({
        ok: true as const,
        ...await readEntryCommits(
          c.env,
          repository.artifactsName,
          ref ?? repository.defaultBranch,
          path,
        ),
      });
    } catch (error) {
      if (error instanceof CodeNotFoundError) {
        return apiError(c, 404, "NOT_FOUND", error.message);
      }
      throw error;
    }
  })
  .get("/repos/:name/files", zValidator("query", refQuerySchema), async (c) => {
    const repository = await findRepository(createDb(c.env.DB), c.req.param("name"));
    if (!repository) return apiError(c, 404, "NOT_FOUND", "Repository not found");
    const { ref } = c.req.valid("query");
    return c.json({
      ok: true as const,
      ...await listCodeFiles(c.env, repository.artifactsName, ref ?? repository.defaultBranch),
    });
  })
  .get("/repos/:name/languages", zValidator("query", refQuerySchema), async (c) => {
    const repository = await findRepository(createDb(c.env.DB), c.req.param("name"));
    if (!repository) return apiError(c, 404, "NOT_FOUND", "Repository not found");
    const { ref } = c.req.valid("query");
    return c.json({
      ok: true as const,
      ...await readLanguages(c.env, repository.artifactsName, ref ?? repository.defaultBranch),
    });
  })
  .route("/repos/:name/tasks", taskRoutes);
