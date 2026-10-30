import { and, desc, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import {
  TASK_LEASE_MINUTES,
  type MergeCheck,
  type ReviewVerdict,
  type TaskAttempt,
  type TaskDetail,
  type TaskMergeability,
  type TaskNote,
  type TaskNoteKind,
  type TaskPerson,
  type TaskReview,
  type TaskStatus,
  type TaskSummary,
} from "../../shared/tasks";
import type { SessionUser } from "../env";
import type { Database } from "../db/client";
import {
  taskAttempts,
  taskDependencies,
  taskNotes,
  taskReviews,
  tasks,
  users,
  type CodeRepositoryRecord,
} from "../db/schema";
import { createId } from "../lib/ids";
import { withArtifactsRepo, type ArtifactsBindings } from "../code/artifacts";
import { divergence, type Fetcher } from "../code/browse";
import { matchingRules } from "../code/ref-policy";
import { RefUpdateRejectedError, updateRef } from "../code/ref-update";
import { listBranchProtections } from "../code/repositories";

/**
 * Tasks live inside a repository and play the role of pull requests:
 * task → executor → attempt → branch → review → fast-forward integration.
 * An attempt holds a renewable lease. When it lapses another executor may
 * claim the task; a late result from the old attempt is kept as that
 * attempt's result and never replaces the newer attempt.
 */

const LEASE_MS = TASK_LEASE_MINUTES * 60 * 1_000;
const MAX_LISTED_TASKS = 500;
const TASK_BRANCH_PREFIX = "tasks/";

export class TaskError extends Error {
  constructor(
    message: string,
    readonly status: 403 | 404 | 409 | 422,
  ) {
    super(message);
  }
}

type Repository = CodeRepositoryRecord;
type TaskRow = typeof tasks.$inferSelect;
type AttemptRow = typeof taskAttempts.$inferSelect;
type ReviewRow = typeof taskReviews.$inferSelect;

async function people(db: Database, ids: Iterable<string | null>) {
  const unique = [...new Set([...ids].filter((id): id is string => Boolean(id)))];
  const rows = unique.length
    ? await db
      .select({ id: users.id, name: users.name, avatarUrl: users.avatarUrl })
      .from(users)
      .where(inArray(users.id, unique))
    : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  return (id: string | null): TaskPerson | null => {
    if (!id) return null;
    return byId.get(id) ?? { id, name: "Unknown user", avatarUrl: null };
  };
}

function isLive(attempt: AttemptRow, now = Date.now()) {
  return attempt.status === "active" && attempt.leaseExpiresAt.getTime() > now;
}

async function findTask(db: Database, repository: Repository, number: number) {
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.repositoryId, repository.id), eq(tasks.number, number)))
    .limit(1);
  if (!task) throw new TaskError(`Task #${number} not found`, 404);
  return task;
}

/** Latest non-comment verdict per reviewer on the exact current commit. */
function reviewState(attempt: AttemptRow | undefined, reviews: ReviewRow[]) {
  if (!attempt?.headSha || attempt.status === "active") return null;
  const latest = new Map<string, ReviewVerdict>();
  for (const review of [...reviews].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    if (review.attemptId !== attempt.id || review.headSha !== attempt.headSha) continue;
    if (review.verdict === "comment") continue;
    latest.set(review.reviewerUserId, review.verdict);
  }
  const verdicts = [...latest.values()];
  if (verdicts.includes("changes_requested")) return "changes_requested" as const;
  if (verdicts.includes("approve")) return "approved" as const;
  return null;
}

async function summaries(
  db: Database,
  repository: Repository,
  rows: TaskRow[],
): Promise<TaskSummary[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const [dependencies, attempts, questions, reviews] = await Promise.all([
    db
      .select({
        taskId: taskDependencies.taskId,
        number: tasks.number,
        status: tasks.status,
      })
      .from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId))
      .where(inArray(taskDependencies.taskId, ids)),
    db.select().from(taskAttempts).where(inArray(taskAttempts.taskId, ids)),
    db
      .select({ taskId: taskNotes.taskId, count: sql<number>`count(*)` })
      .from(taskNotes)
      .where(and(
        inArray(taskNotes.taskId, ids),
        eq(taskNotes.kind, "question"),
        isNull(taskNotes.resolvedAt),
      ))
      .groupBy(taskNotes.taskId),
    db.select().from(taskReviews).where(inArray(taskReviews.taskId, ids)),
  ]);
  const person = await people(db, [
    ...rows.map((row) => row.assigneeUserId),
    ...rows.map((row) => row.createdByUserId),
    ...attempts.map((attempt) => attempt.executorUserId),
  ]);
  const now = Date.now();
  return rows.map((row) => {
    const deps = dependencies.filter((dependency) => dependency.taskId === row.id);
    const own = attempts.filter((attempt) => attempt.taskId === row.id);
    const latest = own.reduce<AttemptRow | undefined>(
      (best, attempt) => (!best || attempt.number > best.number ? attempt : best),
      undefined,
    );
    const active = own.find((attempt) => isLive(attempt, now));
    return {
      number: row.number,
      title: row.title,
      status: row.status,
      repository: repository.name,
      baseBranch: row.baseBranch,
      assignee: person(row.assigneeUserId),
      createdBy: person(row.createdByUserId)!,
      dependsOn: deps.map((dependency) => dependency.number).sort((a, b) => a - b),
      blocked: deps.some((dependency) => dependency.status !== "merged"),
      openQuestions: questions.find((question) => question.taskId === row.id)?.count ?? 0,
      reviewState: reviewState(
        latest,
        reviews.filter((review) => review.taskId === row.id),
      ),
      branch: latest?.branch ?? null,
      headSha: latest?.headSha ?? null,
      activeAttempt: active
        ? {
          number: active.number,
          executor: person(active.executorUserId)!,
          leaseExpiresAt: active.leaseExpiresAt.toISOString(),
        }
        : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

export async function listTasks(db: Database, repository: Repository) {
  const rows = await db
    .select()
    .from(tasks)
    .where(eq(tasks.repositoryId, repository.id))
    .orderBy(desc(tasks.number))
    .limit(MAX_LISTED_TASKS);
  return summaries(db, repository, rows);
}

/** Open work per repository, for the repository list. */
export async function openTaskCounts(db: Database) {
  const rows = await db
    .select({ repositoryId: tasks.repositoryId, count: sql<number>`count(*)` })
    .from(tasks)
    .where(inArray(tasks.status, ["open", "in_progress", "in_review"]))
    .groupBy(tasks.repositoryId);
  return new Map(rows.map((row) => [row.repositoryId, row.count]));
}

export async function getTask(
  db: Database,
  repository: Repository,
  number: number,
): Promise<TaskDetail> {
  const task = await findTask(db, repository, number);
  const [summary] = await summaries(db, repository, [task]);
  const [dependencies, dependents, attempts, notes, reviews] = await Promise.all([
    db
      .select({ number: tasks.number, title: tasks.title, status: tasks.status })
      .from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId))
      .where(eq(taskDependencies.taskId, task.id)),
    db
      .select({ number: tasks.number, title: tasks.title, status: tasks.status })
      .from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.taskId))
      .where(eq(taskDependencies.dependsOnTaskId, task.id)),
    db
      .select()
      .from(taskAttempts)
      .where(eq(taskAttempts.taskId, task.id))
      .orderBy(desc(taskAttempts.number)),
    db
      .select()
      .from(taskNotes)
      .where(eq(taskNotes.taskId, task.id))
      .orderBy(taskNotes.createdAt),
    db
      .select()
      .from(taskReviews)
      .where(eq(taskReviews.taskId, task.id))
      .orderBy(taskReviews.createdAt),
  ]);
  const person = await people(db, [
    task.mergedByUserId,
    ...attempts.map((attempt) => attempt.executorUserId),
    ...notes.map((note) => note.authorUserId),
    ...reviews.map((review) => review.reviewerUserId),
  ]);
  const latest = attempts[0]?.number;
  const attemptById = new Map(attempts.map((attempt) => [attempt.id, attempt]));
  const byNumber = (left: { number: number }, right: { number: number }) =>
    left.number - right.number;
  return {
    ...summary!,
    goal: task.goal,
    acceptanceCriteria: task.acceptanceCriteria,
    scope: task.scope,
    dependencies: dependencies.sort(byNumber),
    dependents: dependents.sort(byNumber),
    attempts: attempts.map((attempt): TaskAttempt => ({
      id: attempt.id,
      number: attempt.number,
      status: attempt.status === "active" && !isLive(attempt) ? "expired" : attempt.status,
      executor: person(attempt.executorUserId)!,
      branch: attempt.branch,
      baseSha: attempt.baseSha,
      headSha: attempt.headSha,
      summary: attempt.summary,
      leaseExpiresAt: attempt.leaseExpiresAt.toISOString(),
      current: attempt.number === latest,
      createdAt: attempt.createdAt.toISOString(),
      updatedAt: attempt.updatedAt.toISOString(),
    })),
    notes: notes.map((note): TaskNote => ({
      id: note.id,
      kind: note.kind,
      body: note.body,
      author: person(note.authorUserId)!,
      resolvedAt: note.resolvedAt?.toISOString() ?? null,
      createdAt: note.createdAt.toISOString(),
    })),
    reviews: reviews.map((review): TaskReview => {
      const attempt = attemptById.get(review.attemptId);
      return {
        id: review.id,
        attemptNumber: attempt?.number ?? 0,
        verdict: review.verdict,
        body: review.body,
        headSha: review.headSha,
        stale: attempt?.headSha !== review.headSha,
        reviewer: person(review.reviewerUserId)!,
        createdAt: review.createdAt.toISOString(),
      };
    }),
    merged: task.mergedSha && task.mergedAt
      ? {
        sha: task.mergedSha,
        by: person(task.mergedByUserId) ?? { id: "", name: "Unknown user", avatarUrl: null },
        at: task.mergedAt.toISOString(),
      }
      : null,
  };
}

async function taskIdsFor(db: Database, repository: Repository, numbers: number[]) {
  if (numbers.length === 0) return [];
  const rows = await db
    .select({ id: tasks.id, number: tasks.number })
    .from(tasks)
    .where(and(eq(tasks.repositoryId, repository.id), inArray(tasks.number, numbers)));
  const missing = numbers.filter((number) => !rows.some((row) => row.number === number));
  if (missing.length) {
    throw new TaskError(`Task #${missing[0]} not found`, 422);
  }
  return rows.map((row) => row.id);
}

/** Rejects dependency edges that would make `taskId` reachable from itself. */
async function assertAcyclic(db: Database, taskId: string, dependsOn: string[]) {
  const edges = await db
    .select({ from: taskDependencies.taskId, to: taskDependencies.dependsOnTaskId })
    .from(taskDependencies);
  const graph = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.from === taskId) continue;
    graph.set(edge.from, [...graph.get(edge.from) ?? [], edge.to]);
  }
  const stack = [...dependsOn];
  const seen = new Set<string>();
  while (stack.length) {
    const current = stack.pop()!;
    if (current === taskId) {
      throw new TaskError("Dependencies would create a cycle", 422);
    }
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...graph.get(current) ?? []);
  }
}

async function branchTip(env: ArtifactsBindings, repository: Repository, ref: string) {
  const [commit] = await withArtifactsRepo(
    env,
    repository.artifactsName,
    (repo) => repo.log({ ref, limit: 1 }),
  );
  return commit?.hash ?? null;
}

export type TaskInput = {
  title: string;
  goal: string;
  acceptanceCriteria: string;
  scope: string;
  baseBranch: string | null;
  dependsOn: number[];
};

/**
 * Creates a task. With `fromBranch`, work that already exists on a branch
 * becomes the task's first submitted attempt, like opening a pull request.
 */
export async function createTask(
  env: ArtifactsBindings,
  db: Database,
  user: SessionUser,
  repository: Repository,
  input: TaskInput & { fromBranch?: string | null },
) {
  const dependencyIds = await taskIdsFor(db, repository, input.dependsOn);
  const baseBranch = input.baseBranch ?? repository.defaultBranch;
  const id = createId("task");
  const now = new Date();
  let attempt: typeof taskAttempts.$inferInsert | null = null;
  if (input.fromBranch) {
    if (input.fromBranch === baseBranch) {
      throw new TaskError("Pick a branch other than the base branch", 422);
    }
    const [headSha, baseSha] = await Promise.all([
      branchTip(env, repository, input.fromBranch),
      branchTip(env, repository, baseBranch),
    ]);
    if (!headSha) throw new TaskError(`Branch ${input.fromBranch} not found`, 422);
    attempt = {
      id: createId("att"),
      taskId: id,
      number: 1,
      executorUserId: user.id,
      status: "submitted",
      branch: input.fromBranch,
      baseSha,
      headSha,
      summary: null,
      leaseExpiresAt: now,
      createdAt: now,
      updatedAt: now,
    };
  }
  // The number is assigned inside the INSERT so concurrent creates cannot
  // pick the same value; the unique index is the final guard.
  await db.batch([
    db.insert(tasks).values({
      id,
      repositoryId: repository.id,
      number: sql`(
        SELECT COALESCE(MAX(${tasks.number}), 0) + 1 FROM ${tasks}
        WHERE ${tasks.repositoryId} = ${repository.id}
      )`,
      title: input.title,
      goal: input.goal,
      acceptanceCriteria: input.acceptanceCriteria,
      scope: input.scope,
      status: attempt ? "in_review" : "open",
      baseBranch,
      assigneeUserId: attempt ? user.id : null,
      createdByUserId: user.id,
      createdAt: now,
      updatedAt: now,
    }),
    ...dependencyIds.map((dependsOnTaskId) =>
      db.insert(taskDependencies).values({ taskId: id, dependsOnTaskId })
    ),
    ...attempt ? [db.insert(taskAttempts).values(attempt)] : [],
  ]);
  const [created] = await db
    .select({ number: tasks.number })
    .from(tasks)
    .where(eq(tasks.id, id));
  return getTask(db, repository, created!.number);
}

export async function updateTask(
  db: Database,
  repository: Repository,
  number: number,
  patch: Partial<TaskInput> & { status?: TaskStatus; assigneeUserId?: string | null },
) {
  const task = await findTask(db, repository, number);
  if (task.status === "merged" && patch.status !== undefined) {
    throw new TaskError("A merged task cannot change status", 409);
  }
  const values: Partial<typeof tasks.$inferInsert> = { updatedAt: new Date() };
  if (patch.title !== undefined) values.title = patch.title;
  if (patch.goal !== undefined) values.goal = patch.goal;
  if (patch.acceptanceCriteria !== undefined) {
    values.acceptanceCriteria = patch.acceptanceCriteria;
  }
  if (patch.scope !== undefined) values.scope = patch.scope;
  if (patch.status !== undefined) values.status = patch.status;
  if (patch.baseBranch !== undefined) {
    values.baseBranch = patch.baseBranch ?? repository.defaultBranch;
  }
  if (patch.assigneeUserId !== undefined) {
    if (patch.assigneeUserId) {
      const [assignee] = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, patch.assigneeUserId), eq(users.status, "active")))
        .limit(1);
      if (!assignee) throw new TaskError("Assignee not found", 422);
    }
    values.assigneeUserId = patch.assigneeUserId;
  }

  const update = db.update(tasks).set(values).where(eq(tasks.id, task.id));
  if (patch.dependsOn !== undefined) {
    const dependencyIds = await taskIdsFor(db, repository, patch.dependsOn);
    if (dependencyIds.includes(task.id)) {
      throw new TaskError("A task cannot depend on itself", 422);
    }
    await assertAcyclic(db, task.id, dependencyIds);
    await db.batch([
      update,
      db.delete(taskDependencies).where(eq(taskDependencies.taskId, task.id)),
      ...dependencyIds.map((dependsOnTaskId) =>
        db.insert(taskDependencies).values({ taskId: task.id, dependsOnTaskId })
      ),
    ]);
  } else {
    await update;
  }
  return getTask(db, repository, number);
}

async function unmergedDependencies(db: Database, task: TaskRow) {
  return db
    .select({ number: tasks.number })
    .from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId))
    .where(and(
      eq(taskDependencies.taskId, task.id),
      ne(tasks.status, "merged"),
    ));
}

function isUniqueViolation(error: unknown) {
  return error instanceof Error && /UNIQUE constraint failed/u.test(
    `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}`,
  );
}

function assertWorkable(task: TaskRow) {
  if (task.status === "merged" || task.status === "closed") {
    throw new TaskError(`Task #${task.number} is ${task.status}`, 409);
  }
}

/** Claims the task with a new attempt pinned to the current base commit. */
export async function startAttempt(
  env: ArtifactsBindings,
  db: Database,
  user: SessionUser,
  repository: Repository,
  number: number,
) {
  const task = await findTask(db, repository, number);
  assertWorkable(task);
  const blockers = await unmergedDependencies(db, task);
  if (blockers.length) {
    const list = blockers.map((blocker) => `#${blocker.number}`).join(", ");
    throw new TaskError(`Task #${number} is blocked by ${list}`, 409);
  }

  const now = new Date();
  // Lapsed leases release the task for the next executor.
  await db
    .update(taskAttempts)
    .set({ status: "expired", updatedAt: now })
    .where(and(
      eq(taskAttempts.taskId, task.id),
      eq(taskAttempts.status, "active"),
      lt(taskAttempts.leaseExpiresAt, now),
    ));

  const baseSha = await branchTip(env, repository, task.baseBranch);
  const leaseExpiresAt = now.getTime() + LEASE_MS;
  const nextAttempt = sql`(
    SELECT COALESCE(MAX(${taskAttempts.number}), 0) + 1
    FROM ${taskAttempts} WHERE ${taskAttempts.taskId} = ${task.id}
  )`;
  try {
    await db.batch([
      db.insert(taskAttempts).values({
        id: createId("att"),
        taskId: task.id,
        number: nextAttempt,
        executorUserId: user.id,
        status: "active",
        branch: sql`${`${TASK_BRANCH_PREFIX}${number}-`} || ${nextAttempt}`,
        baseSha,
        leaseExpiresAt: new Date(leaseExpiresAt),
        createdAt: now,
        updatedAt: now,
      }),
      db
        .update(tasks)
        .set({ status: "in_progress", assigneeUserId: user.id, updatedAt: now })
        .where(eq(tasks.id, task.id)),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new TaskError(`Task #${number} is already claimed`, 409);
    }
    throw error;
  }
  return getTask(db, repository, number);
}

async function findAttempt(
  db: Database,
  repository: Repository,
  number: number,
  attemptNumber: number,
) {
  const task = await findTask(db, repository, number);
  const [attempt] = await db
    .select()
    .from(taskAttempts)
    .where(and(eq(taskAttempts.taskId, task.id), eq(taskAttempts.number, attemptNumber)))
    .limit(1);
  if (!attempt) throw new TaskError(`Attempt ${attemptNumber} not found`, 404);
  const [latest] = await db
    .select({ number: taskAttempts.number })
    .from(taskAttempts)
    .where(eq(taskAttempts.taskId, task.id))
    .orderBy(desc(taskAttempts.number))
    .limit(1);
  return { task, attempt, current: latest?.number === attempt.number };
}

function assertExecutor(user: SessionUser, attempt: AttemptRow) {
  if (attempt.executorUserId !== user.id) {
    throw new TaskError("Only the executor can update this attempt", 403);
  }
}

export async function renewLease(
  db: Database,
  user: SessionUser,
  repository: Repository,
  number: number,
  attemptNumber: number,
) {
  const { attempt } = await findAttempt(db, repository, number, attemptNumber);
  assertExecutor(user, attempt);
  // A lapsed lease may be renewed only while nobody has taken over, which the
  // `active` status guarantees: a new claim marks it expired first.
  if (attempt.status !== "active") {
    throw new TaskError("The lease was lost; start a new attempt", 409);
  }
  const now = new Date();
  await db
    .update(taskAttempts)
    .set({ leaseExpiresAt: new Date(now.getTime() + LEASE_MS), updatedAt: now })
    .where(and(eq(taskAttempts.id, attempt.id), eq(taskAttempts.status, "active")));
  return getTask(db, repository, number);
}

/**
 * Records the attempt's result. Without a SHA the current tip of the attempt
 * branch is used. Submitting again with a new commit publishes a new revision;
 * reviews of the previous commit become stale.
 */
export async function submitAttempt(
  env: ArtifactsBindings,
  db: Database,
  user: SessionUser,
  repository: Repository,
  number: number,
  attemptNumber: number,
  input: { headSha?: string | null; summary?: string | null },
) {
  const { task, attempt, current } = await findAttempt(db, repository, number, attemptNumber);
  assertExecutor(user, attempt);
  assertWorkable(task);
  if (attempt.status === "released" || attempt.status === "merged") {
    throw new TaskError(`This attempt was ${attempt.status}`, 409);
  }
  const headSha = input.headSha ?? await branchTip(env, repository, attempt.branch);
  if (!headSha) {
    throw new TaskError(`Push ${attempt.branch} before submitting`, 422);
  }
  if (attempt.status === "submitted" && attempt.headSha === headSha) {
    // Retrying after a partial failure must not create a second result.
    return getTask(db, repository, number);
  }
  if (input.headSha) {
    const exists = await withArtifactsRepo(
      env,
      repository.artifactsName,
      (repo) => repo.readCommit(headSha),
    );
    if (!exists) throw new TaskError(`Commit ${headSha.slice(0, 12)} is not in the repository; push it first`, 422);
  }
  const now = new Date();
  await db.batch([
    db
      .update(taskAttempts)
      .set({
        status: "submitted",
        headSha,
        ...(input.summary != null ? { summary: input.summary } : {}),
        updatedAt: now,
      })
      .where(eq(taskAttempts.id, attempt.id)),
    // A late result from a superseded attempt is recorded but does not move
    // the task: the newer attempt stays in charge.
    db
      .update(tasks)
      .set(current ? { status: "in_review", updatedAt: now } : { updatedAt: now })
      .where(eq(tasks.id, task.id)),
  ]);
  return getTask(db, repository, number);
}

export async function releaseAttempt(
  db: Database,
  user: SessionUser,
  repository: Repository,
  number: number,
  attemptNumber: number,
  input: { summary: string },
) {
  const { task, attempt, current } = await findAttempt(db, repository, number, attemptNumber);
  assertExecutor(user, attempt);
  if (attempt.status !== "active") {
    throw new TaskError("Only an active attempt can be released", 409);
  }
  const now = new Date();
  await db.batch([
    db
      .update(taskAttempts)
      .set({ status: "released", summary: input.summary, updatedAt: now })
      .where(eq(taskAttempts.id, attempt.id)),
    db
      .update(tasks)
      .set(current
        ? { status: "open", assigneeUserId: null, updatedAt: now }
        : { updatedAt: now })
      .where(eq(tasks.id, task.id)),
  ]);
  return getTask(db, repository, number);
}

export async function addNote(
  db: Database,
  user: SessionUser,
  repository: Repository,
  number: number,
  input: { kind: TaskNoteKind; body: string },
) {
  const task = await findTask(db, repository, number);
  const now = new Date();
  await db.batch([
    db.insert(taskNotes).values({
      id: createId("tnote"),
      taskId: task.id,
      authorUserId: user.id,
      kind: input.kind,
      body: input.body,
      createdAt: now,
    }),
    db.update(tasks).set({ updatedAt: now }).where(eq(tasks.id, task.id)),
  ]);
  return getTask(db, repository, number);
}

export async function setNoteResolved(
  db: Database,
  repository: Repository,
  number: number,
  noteId: string,
  resolved: boolean,
) {
  const task = await findTask(db, repository, number);
  const result = await db
    .update(taskNotes)
    .set({ resolvedAt: resolved ? new Date() : null })
    .where(and(eq(taskNotes.id, noteId), eq(taskNotes.taskId, task.id)))
    .returning({ id: taskNotes.id });
  if (result.length === 0) throw new TaskError("Note not found", 404);
  return getTask(db, repository, number);
}

async function currentResult(db: Database, task: TaskRow) {
  const [attempt] = await db
    .select()
    .from(taskAttempts)
    .where(eq(taskAttempts.taskId, task.id))
    .orderBy(desc(taskAttempts.number))
    .limit(1);
  return attempt?.status === "submitted" && attempt.headSha ? attempt : null;
}

/** Reviews judge the exact commit of the current result. */
export async function addReview(
  db: Database,
  user: SessionUser,
  repository: Repository,
  number: number,
  input: { verdict: ReviewVerdict; body: string },
) {
  const task = await findTask(db, repository, number);
  const attempt = await currentResult(db, task);
  if (!attempt) throw new TaskError("There is no submitted result to review", 409);
  if (input.verdict !== "comment" && attempt.executorUserId === user.id) {
    throw new TaskError("Executors cannot approve or reject their own result", 403);
  }
  if (input.verdict !== "approve" && !input.body.trim()) {
    throw new TaskError("Explain what needs to change", 422);
  }
  const now = new Date();
  await db.batch([
    db.insert(taskReviews).values({
      id: createId("trev"),
      taskId: task.id,
      attemptId: attempt.id,
      reviewerUserId: user.id,
      verdict: input.verdict,
      body: input.body,
      headSha: attempt.headSha!,
      createdAt: now,
    }),
    db.update(tasks).set({ updatedAt: now }).where(eq(tasks.id, task.id)),
  ]);
  return getTask(db, repository, number);
}

/**
 * Integration rules: the result must sit on top of the current base tip (a
 * fast-forward, so what was reviewed is exactly what lands), dependencies are
 * merged, blocking questions are resolved, protected bases need an approval of
 * the exact commit from someone other than the executor, and `admins` bases
 * need an administrator.
 */
export async function taskMergeability(
  env: ArtifactsBindings,
  db: Database,
  user: SessionUser,
  repository: Repository,
  number: number,
): Promise<TaskMergeability> {
  const task = await findTask(db, repository, number);
  const detail = await getTask(db, repository, number);
  const attempt = await currentResult(db, task);
  const rules = matchingRules(task.baseBranch, await listBranchProtections(db, repository.id));
  const position = attempt
    ? await withArtifactsRepo(
      env,
      repository.artifactsName,
      (repo) => divergence(repo, task.baseBranch, attempt.headSha!),
    )
    : null;

  const checks: MergeCheck[] = [];
  checks.push(attempt
    ? { id: "result", ok: true, label: `Result submitted at ${attempt.headSha!.slice(0, 7)}` }
    : { id: "result", ok: false, label: "No submitted result yet" });

  if (position) {
    if (position.baseSha === null) {
      checks.push({ id: "up_to_date", ok: false, label: `${task.baseBranch} does not exist yet` });
    } else if (position.behindBy === null) {
      checks.push({ id: "up_to_date", ok: false, label: `No shared history with ${task.baseBranch}` });
    } else if (position.behindBy > 0) {
      checks.push({
        id: "up_to_date",
        ok: false,
        label: `${position.behindBy} commit${position.behindBy === 1 ? "" : "s"} behind ${task.baseBranch}: rebase ${attempt!.branch} and submit again`,
      });
    } else if (position.aheadBy === 0) {
      checks.push({ id: "up_to_date", ok: false, label: `No changes beyond ${task.baseBranch}` });
    } else {
      checks.push({ id: "up_to_date", ok: true, label: `Fast-forwards ${task.baseBranch}` });
    }
  }

  const blockers = detail.dependencies.filter((dependency) => dependency.status !== "merged");
  checks.push(blockers.length
    ? {
      id: "dependencies",
      ok: false,
      label: `Waiting for ${blockers.map((dependency) => `#${dependency.number}`).join(", ")} to merge`,
    }
    : { id: "dependencies", ok: true, label: "Dependencies merged" });

  checks.push(detail.openQuestions > 0
    ? { id: "questions", ok: false, label: `${detail.openQuestions} open question${detail.openQuestions === 1 ? "" : "s"}` }
    : { id: "questions", ok: true, label: "No open questions" });

  const protectedBase = rules.length > 0;
  if (detail.reviewState === "changes_requested") {
    checks.push({ id: "approval", ok: false, label: "Changes requested" });
  } else if (detail.reviewState === "approved") {
    checks.push({ id: "approval", ok: true, label: "Approved at this commit" });
  } else if (protectedBase) {
    checks.push({ id: "approval", ok: false, label: `${task.baseBranch} is protected: approval required` });
  } else {
    checks.push({ id: "approval", ok: true, label: "Review not required" });
  }

  const needsAdmin = rules.some((rule) => rule.push === "admins");
  checks.push(needsAdmin && user.role !== "admin"
    ? { id: "permission", ok: false, label: `Only administrators can merge into ${task.baseBranch}` }
    : { id: "permission", ok: true, label: "You can merge" });

  const failing = checks.filter((check) => !check.ok);
  const merged = task.status === "merged";
  return {
    baseBranch: task.baseBranch,
    baseSha: position?.baseSha ?? null,
    headSha: attempt?.headSha ?? null,
    branch: attempt?.branch ?? null,
    aheadBy: position?.aheadBy ?? 0,
    behindBy: position?.behindBy ?? 0,
    checks,
    canMerge: !merged && failing.length === 0,
    canBypassReview: !merged
      && user.role === "admin"
      && failing.length > 0
      && failing.every((check) => check.id === "approval")
      && detail.reviewState !== "changes_requested",
  };
}

/** Fast-forwards the base branch to the reviewed commit. */
export async function mergeTask(
  env: ArtifactsBindings,
  db: Database,
  user: SessionUser,
  repository: Repository,
  number: number,
  options: { bypassReview: boolean; deleteBranch: boolean },
  fetcher: Fetcher,
) {
  const task = await findTask(db, repository, number);
  if (task.status === "merged") return getTask(db, repository, number);
  const state = await taskMergeability(env, db, user, repository, number);
  if (!state.canMerge && !(options.bypassReview && state.canBypassReview)) {
    const reason = state.checks.find((check) => !check.ok)?.label ?? "Not mergeable";
    throw new TaskError(reason, 409);
  }
  const attempt = (await currentResult(db, task))!;
  try {
    await updateRef(env, repository.artifactsName, {
      ref: `refs/heads/${task.baseBranch}`,
      oldOid: state.baseSha!,
      newOid: attempt.headSha!,
    }, fetcher);
  } catch (error) {
    if (error instanceof RefUpdateRejectedError) {
      throw new TaskError(`${task.baseBranch} moved while merging; try again (${error.message})`, 409);
    }
    throw error;
  }
  const now = new Date();
  await db.batch([
    db
      .update(taskAttempts)
      // Keep the base the result landed on so the merged diff stays exact.
      .set({ status: "merged", baseSha: state.baseSha, updatedAt: now })
      .where(eq(taskAttempts.id, attempt.id)),
    db
      .update(tasks)
      .set({
        status: "merged",
        mergedSha: attempt.headSha,
        mergedAt: now,
        mergedByUserId: user.id,
        updatedAt: now,
      })
      .where(eq(tasks.id, task.id)),
  ]);
  if (options.deleteBranch && attempt.branch.startsWith(TASK_BRANCH_PREFIX)) {
    // Best effort: the branch is only removed if nobody pushed to it since.
    await updateRef(env, repository.artifactsName, {
      ref: `refs/heads/${attempt.branch}`,
      oldOid: attempt.headSha!,
      newOid: "0".repeat(40),
    }, fetcher).catch(() => undefined);
  }
  return getTask(db, repository, number);
}

export async function listAssignableUsers(db: Database): Promise<TaskPerson[]> {
  return db
    .select({ id: users.id, name: users.name, avatarUrl: users.avatarUrl })
    .from(users)
    .where(eq(users.status, "active"))
    .orderBy(users.name);
}
