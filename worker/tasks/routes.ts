import { zValidator } from "@hono/zod-validator";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { manualTaskStatuses, reviewVerdicts, taskNoteKinds } from "../../shared/tasks";
import { ArtifactsUnavailableError } from "../code/artifacts";
import { findRepository } from "../code/repositories";
import { branchNameSchema } from "../code/schemas";
import { createDb } from "../db/client";
import type { CodeRepositoryRecord } from "../db/schema";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import {
  addNote,
  addReview,
  createTask,
  getTask,
  listAssignableUsers,
  listTasks,
  mergeTask,
  releaseAttempt,
  renewLease,
  setNoteResolved,
  startAttempt,
  submitAttempt,
  TaskError,
  taskMergeability,
  updateTask,
} from "./service";

const text = (max: number) => z.string().trim().max(max);
const dependsOnSchema = z.array(z.number().int().positive()).max(50)
  .transform((numbers) => [...new Set(numbers)]);
const shaSchema = z.string().trim().toLowerCase()
  .regex(/^[0-9a-f]{40}$/u, "Enter a full commit SHA");

const createTaskSchema = z.object({
  title: text(200).min(1),
  goal: text(20_000).default(""),
  acceptanceCriteria: text(20_000).default(""),
  scope: text(20_000).default(""),
  baseBranch: branchNameSchema.nullish().transform((value) => value ?? null),
  dependsOn: dependsOnSchema.default([]),
  fromBranch: branchNameSchema.nullish().transform((value) => value ?? null),
});

const updateTaskSchema = z.object({
  title: text(200).min(1).optional(),
  goal: text(20_000).optional(),
  acceptanceCriteria: text(20_000).optional(),
  scope: text(20_000).optional(),
  status: z.enum(manualTaskStatuses).optional(),
  baseBranch: branchNameSchema.nullable().optional(),
  assigneeUserId: z.string().min(1).max(100).nullable().optional(),
  dependsOn: dependsOnSchema.optional(),
});

const submitSchema = z.object({
  headSha: shaSchema.nullish(),
  summary: text(20_000).nullish(),
});

const releaseSchema = z.object({ summary: text(20_000).default("") });

const noteSchema = z.object({
  kind: z.enum(taskNoteKinds),
  body: text(20_000).min(1),
});

const resolveSchema = z.object({ resolved: z.boolean() });

const reviewSchema = z.object({
  verdict: z.enum(reviewVerdicts),
  body: text(20_000).default(""),
});

const mergeSchema = z.object({
  bypassReview: z.boolean().default(false),
  deleteBranch: z.boolean().default(true),
});

const globalFetch = (input: string, init?: RequestInit) => fetch(input, init);

type TaskEnv = AppEnv & { Variables: { repository: CodeRepositoryRecord } };

function positive(value: string | undefined) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function handleError(c: Context, error: unknown) {
  if (error instanceof TaskError) {
    const code = {
      403: "FORBIDDEN",
      404: "NOT_FOUND",
      409: "CONFLICT",
      422: "BAD_REQUEST",
    } as const;
    return apiError(c, error.status, code[error.status], error.message);
  }
  if (error instanceof ArtifactsUnavailableError) {
    return apiError(c, 503, "UNAVAILABLE", error.message);
  }
  throw error;
}

/** Repository tasks, mounted at `/api/code/repos/:name/tasks` behind auth. */
export const taskRoutes = new Hono<TaskEnv>()
  .use("*", async (c, next) => {
    const repository = await findRepository(createDb(c.env.DB), c.req.param("name") ?? "");
    if (!repository) return apiError(c, 404, "NOT_FOUND", "Repository not found");
    c.set("repository", repository);
    await next();
  })
  .get("/", async (c) => {
    return c.json({
      ok: true as const,
      tasks: await listTasks(createDb(c.env.DB), c.get("repository")),
    });
  })
  .get("/people", async (c) => {
    return c.json({ ok: true as const, people: await listAssignableUsers(createDb(c.env.DB)) });
  })
  .post("/", zValidator("json", createTaskSchema), async (c) => {
    try {
      const task = await createTask(
        c.env,
        createDb(c.env.DB),
        c.get("user"),
        c.get("repository"),
        c.req.valid("json"),
      );
      return c.json({ ok: true as const, task }, 201);
    } catch (error) {
      return handleError(c, error);
    }
  })
  .get("/:number", async (c) => {
    const number = positive(c.req.param("number"));
    if (!number) return apiError(c, 404, "NOT_FOUND", "Task not found");
    try {
      return c.json({
        ok: true as const,
        task: await getTask(createDb(c.env.DB), c.get("repository"), number),
      });
    } catch (error) {
      return handleError(c, error);
    }
  })
  .patch("/:number", zValidator("json", updateTaskSchema), async (c) => {
    const number = positive(c.req.param("number"));
    if (!number) return apiError(c, 404, "NOT_FOUND", "Task not found");
    try {
      return c.json({
        ok: true as const,
        task: await updateTask(
          createDb(c.env.DB),
          c.get("repository"),
          number,
          c.req.valid("json"),
        ),
      });
    } catch (error) {
      return handleError(c, error);
    }
  })
  .get("/:number/mergeability", async (c) => {
    const number = positive(c.req.param("number"));
    if (!number) return apiError(c, 404, "NOT_FOUND", "Task not found");
    try {
      return c.json({
        ok: true as const,
        mergeability: await taskMergeability(
          c.env,
          createDb(c.env.DB),
          c.get("user"),
          c.get("repository"),
          number,
        ),
      });
    } catch (error) {
      return handleError(c, error);
    }
  })
  .post("/:number/merge", zValidator("json", mergeSchema), async (c) => {
    const number = positive(c.req.param("number"));
    if (!number) return apiError(c, 404, "NOT_FOUND", "Task not found");
    try {
      return c.json({
        ok: true as const,
        task: await mergeTask(
          c.env,
          createDb(c.env.DB),
          c.get("user"),
          c.get("repository"),
          number,
          c.req.valid("json"),
          globalFetch,
        ),
      });
    } catch (error) {
      return handleError(c, error);
    }
  })
  .post("/:number/reviews", zValidator("json", reviewSchema), async (c) => {
    const number = positive(c.req.param("number"));
    if (!number) return apiError(c, 404, "NOT_FOUND", "Task not found");
    try {
      return c.json({
        ok: true as const,
        task: await addReview(
          createDb(c.env.DB),
          c.get("user"),
          c.get("repository"),
          number,
          c.req.valid("json"),
        ),
      }, 201);
    } catch (error) {
      return handleError(c, error);
    }
  })
  .post("/:number/attempts", async (c) => {
    const number = positive(c.req.param("number"));
    if (!number) return apiError(c, 404, "NOT_FOUND", "Task not found");
    try {
      const task = await startAttempt(
        c.env,
        createDb(c.env.DB),
        c.get("user"),
        c.get("repository"),
        number,
      );
      return c.json({ ok: true as const, task }, 201);
    } catch (error) {
      return handleError(c, error);
    }
  })
  .post("/:number/attempts/:attempt/lease", async (c) => {
    const number = positive(c.req.param("number"));
    const attempt = positive(c.req.param("attempt"));
    if (!number || !attempt) return apiError(c, 404, "NOT_FOUND", "Attempt not found");
    try {
      return c.json({
        ok: true as const,
        task: await renewLease(
          createDb(c.env.DB),
          c.get("user"),
          c.get("repository"),
          number,
          attempt,
        ),
      });
    } catch (error) {
      return handleError(c, error);
    }
  })
  .post(
    "/:number/attempts/:attempt/submit",
    zValidator("json", submitSchema),
    async (c) => {
      const number = positive(c.req.param("number"));
      const attempt = positive(c.req.param("attempt"));
      if (!number || !attempt) return apiError(c, 404, "NOT_FOUND", "Attempt not found");
      try {
        return c.json({
          ok: true as const,
          task: await submitAttempt(
            c.env,
            createDb(c.env.DB),
            c.get("user"),
            c.get("repository"),
            number,
            attempt,
            c.req.valid("json"),
          ),
        });
      } catch (error) {
        return handleError(c, error);
      }
    },
  )
  .post(
    "/:number/attempts/:attempt/release",
    zValidator("json", releaseSchema),
    async (c) => {
      const number = positive(c.req.param("number"));
      const attempt = positive(c.req.param("attempt"));
      if (!number || !attempt) return apiError(c, 404, "NOT_FOUND", "Attempt not found");
      try {
        return c.json({
          ok: true as const,
          task: await releaseAttempt(
            createDb(c.env.DB),
            c.get("user"),
            c.get("repository"),
            number,
            attempt,
            c.req.valid("json"),
          ),
        });
      } catch (error) {
        return handleError(c, error);
      }
    },
  )
  .post("/:number/notes", zValidator("json", noteSchema), async (c) => {
    const number = positive(c.req.param("number"));
    if (!number) return apiError(c, 404, "NOT_FOUND", "Task not found");
    try {
      return c.json({
        ok: true as const,
        task: await addNote(
          createDb(c.env.DB),
          c.get("user"),
          c.get("repository"),
          number,
          c.req.valid("json"),
        ),
      }, 201);
    } catch (error) {
      return handleError(c, error);
    }
  })
  .patch("/:number/notes/:noteId", zValidator("json", resolveSchema), async (c) => {
    const number = positive(c.req.param("number"));
    if (!number) return apiError(c, 404, "NOT_FOUND", "Task not found");
    try {
      return c.json({
        ok: true as const,
        task: await setNoteResolved(
          createDb(c.env.DB),
          c.get("repository"),
          number,
          c.req.param("noteId"),
          c.req.valid("json").resolved,
        ),
      });
    } catch (error) {
      return handleError(c, error);
    }
  });
