import type { CodeCommit, CodeFileChange } from "./code";

/**
 * Tasks are the repository's unit of change, like pull requests with a
 * coordination layer on top: a goal and agreed decisions, renewable claims by
 * people or agents, attempts pinned to exact commits, reviews bound to SHAs,
 * and a fast-forward-only integration into the base branch.
 */
export const taskStatuses = [
  "open",
  "in_progress",
  "in_review",
  "merged",
  "closed",
] as const;
export type TaskStatus = (typeof taskStatuses)[number];

/** Statuses a person may set directly; the rest follow attempts and merges. */
export const manualTaskStatuses = ["open", "closed"] as const;

export const attemptStatuses = [
  "active",
  "submitted",
  "released",
  "expired",
  "merged",
] as const;
export type AttemptStatus = (typeof attemptStatuses)[number];

/** Decisions record agreed contracts; questions block merging until resolved. */
export const taskNoteKinds = ["note", "decision", "question"] as const;
export type TaskNoteKind = (typeof taskNoteKinds)[number];

export const reviewVerdicts = ["approve", "changes_requested", "comment"] as const;
export type ReviewVerdict = (typeof reviewVerdicts)[number];

export const TASK_LEASE_MINUTES = 30;

export type TaskPerson = { id: string; name: string; avatarUrl: string | null };

export type TaskSummary = {
  number: number;
  title: string;
  status: TaskStatus;
  repository: string;
  baseBranch: string;
  assignee: TaskPerson | null;
  createdBy: TaskPerson;
  dependsOn: number[];
  blocked: boolean;
  openQuestions: number;
  /** Verdict of the latest non-stale reviews on the current result. */
  reviewState: "approved" | "changes_requested" | null;
  branch: string | null;
  headSha: string | null;
  activeAttempt: {
    number: number;
    executor: TaskPerson;
    leaseExpiresAt: string;
  } | null;
  createdAt: string;
  updatedAt: string;
};

export type TaskAttempt = {
  id: string;
  number: number;
  status: AttemptStatus;
  executor: TaskPerson;
  branch: string;
  baseSha: string | null;
  headSha: string | null;
  summary: string | null;
  leaseExpiresAt: string;
  /** False for results that arrived after another attempt took over. */
  current: boolean;
  createdAt: string;
  updatedAt: string;
};

export type TaskNote = {
  id: string;
  kind: TaskNoteKind;
  body: string;
  author: TaskPerson;
  resolvedAt: string | null;
  createdAt: string;
};

export type TaskReview = {
  id: string;
  attemptNumber: number;
  verdict: ReviewVerdict;
  body: string;
  headSha: string;
  /** The attempt moved past the reviewed commit. */
  stale: boolean;
  reviewer: TaskPerson;
  createdAt: string;
};

export type TaskDetail = TaskSummary & {
  goal: string;
  acceptanceCriteria: string;
  scope: string;
  dependencies: Array<{ number: number; title: string; status: TaskStatus }>;
  dependents: Array<{ number: number; title: string; status: TaskStatus }>;
  attempts: TaskAttempt[];
  notes: TaskNote[];
  reviews: TaskReview[];
  merged: { sha: string; by: TaskPerson; at: string } | null;
};

/** Changes of `head` relative to where it forked from `base`. */
export type CodeComparison = {
  base: string;
  head: string;
  baseSha: string | null;
  headSha: string | null;
  mergeBase: string | null;
  /** Commits only on head, newest first. */
  commits: CodeCommit[];
  aheadBy: number;
  behindBy: number;
  files: CodeFileChange[];
  truncated: boolean;
};

export type MergeCheck = {
  id: "result" | "up_to_date" | "approval" | "questions" | "dependencies" | "permission";
  ok: boolean;
  label: string;
};

export type TaskMergeability = {
  baseBranch: string;
  baseSha: string | null;
  headSha: string | null;
  branch: string | null;
  aheadBy: number;
  behindBy: number;
  checks: MergeCheck[];
  canMerge: boolean;
  /** Administrators may merge without an approval on protected branches. */
  canBypassReview: boolean;
};
