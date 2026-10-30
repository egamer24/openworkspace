/**
 * Repository names are global within a workspace and form the Git remote path
 * (`https://workspace.example.com/<name>.git`). They also become the
 * Cloudflare Artifacts repository name, so stay within its alphabet.
 */
export const REPOSITORY_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/u;

export function isValidRepositoryName(name: string) {
  return REPOSITORY_NAME_PATTERN.test(name)
    && !name.endsWith(".git")
    && !name.includes("..");
}

/**
 * Who may update branches matching a protection rule.
 * `integration` means no direct pushes: only the server-side integration
 * queue advances the branch.
 */
export const branchPushPolicies = ["members", "admins", "integration"] as const;
export type BranchPushPolicy = (typeof branchPushPolicies)[number];

export type CodeRepository = {
  name: string;
  description: string | null;
  defaultBranch: string;
  createdAt: string;
  openTasks: number;
};

export type BranchProtectionRule = {
  pattern: string;
  push: BranchPushPolicy;
  allowDeletion: boolean;
};

export type CodeRef = { name: string; hash: string };

export type CodeRefs = {
  defaultBranch: string;
  branches: CodeRef[];
  tags: CodeRef[];
};

export type CodePerson = { name: string; email: string };

export type CodeCommit = {
  hash: string;
  treeHash: string;
  message: string;
  author: CodePerson;
  committer: CodePerson;
  parents: string[];
  authoredAt: string;
  committedAt: string;
};

export type CodeTreeEntry = {
  name: string;
  hash: string;
  type: "tree" | "blob" | "symlink" | "gitlink" | "exec";
  mode: string;
};

export type CodeTree = {
  commit: CodeCommit | null;
  entries: CodeTreeEntry[];
};

export type CodeBlob = {
  path: string;
  hash: string;
  size: number;
  commit: CodeCommit;
  kind: "text" | "binary" | "too-large";
  text: string | null;
};

export type CodeFileChange = {
  path: string;
  status: "added" | "deleted" | "modified";
  additions: number;
  deletions: number;
  /** Unified diff hunks without file headers, or null when not displayable. */
  patch: string | null;
  note: string | null;
};

export type CodeCommitDetail = {
  commit: CodeCommit;
  files: CodeFileChange[];
  truncated: boolean;
};

export type CodeBranch = {
  name: string;
  hash: string;
  commit: CodeCommit | null;
  isDefault: boolean;
  protected: boolean;
  /** Relative to the default branch; null when history is too long to tell. */
  aheadBy: number | null;
  behindBy: number | null;
};

export type CodeTag = {
  name: string;
  hash: string;
  commit: CodeCommit | null;
};

/** Latest commit that changed each entry of a directory, by entry name. */
export type CodeEntryCommits = {
  commits: Record<string, CodeCommit>;
  /** Some entries were not resolved within the scanned history. */
  partial: boolean;
};

export type CodeFileIndex = {
  paths: string[];
  truncated: boolean;
};

export type CodeLanguages = {
  languages: Array<{ name: string; color: string; bytes: number; percent: number }>;
  /** Very large repositories are measured from a subset of files. */
  partial: boolean;
};
