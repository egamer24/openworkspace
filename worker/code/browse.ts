import { structuredPatch } from "diff";
import type {
  CodeBlob,
  CodeBranch,
  CodeEntryCommits,
  CodeFileIndex,
  CodeTag,
  CodeCommit,
  CodeCommitDetail,
  CodeFileChange,
  CodeRefs,
  CodeTree,
  CodeTreeEntry,
} from "../../shared/code";
import type { CodeComparison } from "../../shared/tasks";
import {
  gitUpstream,
  withArtifactsRepo,
  type ArtifactsBindings,
} from "./artifacts";

/**
 * Read-only repository browsing. Objects and history come from the Artifacts
 * binding; ref names come from the Git upload-pack advertisement because the
 * binding has no ref listing.
 */

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

const OID = /^[0-9a-f]{40}$/u;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_DIFF_FILES = 300;
const MAX_DIFF_FILE_BYTES = 256 * 1024;
const MAX_TREE_DEPTH = 32;
const decoder = new TextDecoder();

export class CodeNotFoundError extends Error {}

/** The binding does not document the unit; accept seconds or milliseconds. */
function timestamp(value: number) {
  return new Date(value > 1e12 ? value : value * 1_000).toISOString();
}

function toCommit(commit: ArtifactsCommitMetadata): CodeCommit {
  return {
    hash: commit.hash,
    treeHash: commit.treeHash,
    message: commit.message,
    author: commit.author,
    committer: commit.committer,
    parents: commit.parents,
    authoredAt: timestamp(commit.authoredAt),
    committedAt: timestamp(commit.committedAt),
  };
}

/** Parses a protocol v0 `info/refs?service=git-upload-pack` advertisement. */
export function parseRefAdvertisement(body: Uint8Array) {
  const refs = new Map<string, string>();
  let head: string | null = null;
  let offset = 0;
  while (offset + 4 <= body.byteLength) {
    const length = Number.parseInt(decoder.decode(body.subarray(offset, offset + 4)), 16);
    if (Number.isNaN(length)) break;
    if (length === 0) {
      offset += 4;
      continue;
    }
    let line = decoder.decode(body.subarray(offset + 4, offset + length));
    offset += length;
    if (line.startsWith("#")) continue;
    line = line.replace(/\n$/u, "");
    const nul = line.indexOf("\0");
    if (nul >= 0) {
      const symref = line
        .slice(nul + 1)
        .split(" ")
        .find((capability) => capability.startsWith("symref=HEAD:"));
      if (symref) head = symref.slice("symref=HEAD:".length);
      line = line.slice(0, nul);
    }
    const [oid, name] = line.split(" ");
    if (!oid || !name || !OID.test(oid) || /^0+$/u.test(oid)) continue;
    if (name.endsWith("^{}")) continue;
    refs.set(name, oid);
  }
  return { refs, head };
}

export async function listRefs(
  env: ArtifactsBindings,
  artifactsName: string,
  defaultBranch: string,
  fetcher: Fetcher,
): Promise<CodeRefs> {
  const upstream = await gitUpstream(env, artifactsName, "read");
  const response = await fetcher(
    `${upstream.remote}/info/refs?service=git-upload-pack`,
    { headers: { authorization: upstream.authorization } },
  );
  if (!response.ok) throw new Error(`Ref advertisement failed (${response.status})`);
  const { refs, head } = parseRefAdvertisement(
    new Uint8Array(await response.arrayBuffer()),
  );
  const branches: CodeRefs["branches"] = [];
  const tags: CodeRefs["tags"] = [];
  for (const [name, hash] of refs) {
    if (name.startsWith("refs/heads/")) {
      branches.push({ name: name.slice("refs/heads/".length), hash });
    } else if (name.startsWith("refs/tags/")) {
      tags.push({ name: name.slice("refs/tags/".length), hash });
    }
  }
  const byName = (left: { name: string }, right: { name: string }) =>
    left.name.localeCompare(right.name);
  branches.sort(byName);
  tags.sort(byName);
  const headBranch = head?.startsWith("refs/heads/")
    ? head.slice("refs/heads/".length)
    : null;
  const exists = (name: string | null) =>
    Boolean(name && branches.some((branch) => branch.name === name));
  return {
    defaultBranch: exists(defaultBranch)
      ? defaultBranch
      : exists(headBranch) ? headBranch! : defaultBranch,
    branches,
    tags,
  };
}

export async function resolveCommit(repo: ArtifactsRepo, ref: string) {
  if (OID.test(ref)) {
    const commit = await repo.readCommit(ref);
    if (commit) return commit;
  }
  const [commit] = await repo.log({ ref, limit: 1 });
  return commit ?? null;
}

function sortEntries(entries: ArtifactsTreeEntry[]): CodeTreeEntry[] {
  return entries
    .map((entry) => ({
      name: entry.name,
      hash: entry.hash,
      type: entry.type,
      mode: entry.mode,
    }))
    .sort((left, right) => {
      const leftDir = left.type === "tree" ? 0 : 1;
      const rightDir = right.type === "tree" ? 0 : 1;
      return leftDir - rightDir || left.name.localeCompare(right.name);
    });
}

function pathSegments(path: string) {
  const segments = path.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new CodeNotFoundError("Path not found");
  }
  return segments;
}

async function readTreeAt(repo: ArtifactsRepo, rootTree: string, segments: string[]) {
  let treeHash = rootTree;
  for (const segment of segments) {
    const entries = await repo.readTree(treeHash);
    const next = entries?.find((entry) => entry.name === segment);
    if (!next || next.type !== "tree") throw new CodeNotFoundError("Path not found");
    treeHash = next.hash;
  }
  const entries = await repo.readTree(treeHash);
  if (!entries) throw new CodeNotFoundError("Path not found");
  return entries;
}

export async function readCodeTree(
  env: ArtifactsBindings,
  artifactsName: string,
  ref: string,
  path: string,
): Promise<CodeTree> {
  return withArtifactsRepo(env, artifactsName, async (repo) => {
    const commit = await resolveCommit(repo, ref);
    if (!commit) {
      // An empty repository has no commits on any ref yet.
      if (!path) return { commit: null, entries: [] };
      throw new CodeNotFoundError("Ref not found");
    }
    const entries = await readTreeAt(repo, commit.treeHash, pathSegments(path));
    return { commit: toCommit(commit), entries: sortEntries(entries) };
  });
}

function isBinary(bytes: Uint8Array) {
  const sample = bytes.subarray(0, 8_000);
  return sample.includes(0);
}

export async function readCodeBlob(
  env: ArtifactsBindings,
  artifactsName: string,
  ref: string,
  path: string,
): Promise<CodeBlob> {
  return withArtifactsRepo(env, artifactsName, async (repo) => {
    const commit = await resolveCommit(repo, ref);
    if (!commit) throw new CodeNotFoundError("Ref not found");
    const segments = pathSegments(path);
    const name = segments.pop();
    if (!name) throw new CodeNotFoundError("Path not found");
    const entries = await readTreeAt(repo, commit.treeHash, segments);
    const entry = entries.find((item) => item.name === name);
    if (!entry || entry.type === "tree" || entry.type === "gitlink") {
      throw new CodeNotFoundError("File not found");
    }
    const blob = await repo.readBlob(entry.hash);
    if (!blob) throw new CodeNotFoundError("File not found");
    const base = { path, hash: entry.hash, size: blob.size, commit: toCommit(commit) };
    if (blob.size > MAX_TEXT_BYTES) return { ...base, kind: "too-large" as const, text: null };
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (isBinary(bytes)) return { ...base, kind: "binary" as const, text: null };
    return { ...base, kind: "text" as const, text: decoder.decode(bytes) };
  });
}

export async function readCodeRaw(
  env: ArtifactsBindings,
  artifactsName: string,
  ref: string,
  path: string,
) {
  return withArtifactsRepo(env, artifactsName, async (repo) => {
    const file = await repo.readFile({ ref, path });
    if (!file) throw new CodeNotFoundError("File not found");
    return file;
  });
}

export async function listCodeCommits(
  env: ArtifactsBindings,
  artifactsName: string,
  ref: string,
  limit: number,
  offset: number,
) {
  return withArtifactsRepo(env, artifactsName, async (repo) => {
    // Ask for one extra commit to know whether another page exists.
    const commits = await repo.log({ ref, limit: limit + 1, offset });
    return {
      commits: commits.slice(0, limit).map(toCommit),
      hasMore: commits.length > limit,
    };
  });
}

type FlatEntry = { hash: string; mode: string; type: ArtifactsTreeEntryType };

/** Lists changed paths between two trees, descending only into differing subtrees. */
async function diffTrees(
  repo: ArtifactsRepo,
  before: string | null,
  after: string | null,
  prefix: string,
  changes: Map<string, { before?: FlatEntry; after?: FlatEntry }>,
  depth = 0,
) {
  if (before === after || depth > MAX_TREE_DEPTH || changes.size > MAX_DIFF_FILES) return;
  const [beforeEntries, afterEntries] = await Promise.all([
    before ? repo.readTree(before) : Promise.resolve([]),
    after ? repo.readTree(after) : Promise.resolve([]),
  ]);
  const left = new Map((beforeEntries ?? []).map((entry) => [entry.name, entry]));
  const right = new Map((afterEntries ?? []).map((entry) => [entry.name, entry]));
  const names = [...new Set([...left.keys(), ...right.keys()])].sort();
  for (const name of names) {
    const old = left.get(name);
    const next = right.get(name);
    if (old?.hash === next?.hash && old?.mode === next?.mode) continue;
    const path = `${prefix}${name}`;
    const oldTree = old?.type === "tree" ? old.hash : null;
    const nextTree = next?.type === "tree" ? next.hash : null;
    if (oldTree || nextTree) {
      await diffTrees(repo, oldTree, nextTree, `${path}/`, changes, depth + 1);
    }
    const oldFile = old && old.type !== "tree" ? old : undefined;
    const nextFile = next && next.type !== "tree" ? next : undefined;
    if (oldFile || nextFile) {
      changes.set(path, {
        ...(oldFile ? { before: oldFile } : {}),
        ...(nextFile ? { after: nextFile } : {}),
      });
    }
  }
}

async function blobText(repo: ArtifactsRepo, entry: FlatEntry | undefined) {
  if (!entry || entry.type === "gitlink") return { text: "", binary: false, large: false };
  const blob = await repo.readBlob(entry.hash);
  if (!blob) return { text: "", binary: false, large: false };
  if (blob.size > MAX_DIFF_FILE_BYTES) return { text: "", binary: false, large: true };
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (isBinary(bytes)) return { text: "", binary: true, large: false };
  return { text: decoder.decode(bytes), binary: false, large: false };
}

/** Diffs two root trees into displayable file changes. */
export async function diffRootTrees(
  repo: ArtifactsRepo,
  before: string | null,
  after: string | null,
) {
  const changes = new Map<string, { before?: FlatEntry; after?: FlatEntry }>();
  await diffTrees(repo, before, after, "", changes);
  const files: CodeFileChange[] = [];
  for (const [path, change] of [...changes].slice(0, MAX_DIFF_FILES)) {
    const status = !change.before ? "added" : !change.after ? "deleted" : "modified";
    const [beforeText, afterText] = await Promise.all([
      blobText(repo, change.before),
      blobText(repo, change.after),
    ]);
    if (beforeText.binary || afterText.binary || beforeText.large || afterText.large) {
      files.push({
        path,
        status,
        additions: 0,
        deletions: 0,
        patch: null,
        note: beforeText.large || afterText.large ? "File too large to display" : "Binary file",
      });
      continue;
    }
    const patch = structuredPatch(path, path, beforeText.text, afterText.text, "", "", {
      context: 3,
    });
    let additions = 0;
    let deletions = 0;
    const lines: string[] = [];
    for (const hunk of patch.hunks) {
      lines.push(
        `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      );
      for (const line of hunk.lines) {
        if (line.startsWith("+")) additions += 1;
        else if (line.startsWith("-")) deletions += 1;
        lines.push(line);
      }
    }
    files.push({ path, status, additions, deletions, patch: lines.join("\n"), note: null });
  }
  return { files, truncated: changes.size > MAX_DIFF_FILES };
}

export async function readCodeCommit(
  env: ArtifactsBindings,
  artifactsName: string,
  hash: string,
): Promise<CodeCommitDetail> {
  if (!OID.test(hash)) throw new CodeNotFoundError("Commit not found");
  return withArtifactsRepo(env, artifactsName, async (repo) => {
    const commit = await repo.readCommit(hash);
    if (!commit) throw new CodeNotFoundError("Commit not found");
    const parentHash = commit.parents[0];
    const parent = parentHash ? await repo.readCommit(parentHash) : null;
    return {
      commit: toCommit(commit),
      ...await diffRootTrees(repo, parent?.treeHash ?? null, commit.treeHash),
    };
  });
}

/**
 * History walks follow first parents only (that is what `log` returns), which
 * matches the linear, rebased history tasks integrate with.
 */
const MAX_HISTORY = 1000;

function forkPoint(baseLog: ArtifactsCommitMetadata[], headLog: ArtifactsCommitMetadata[]) {
  const baseIndex = new Map(baseLog.map((commit, index) => [commit.hash, index]));
  for (let ahead = 0; ahead < headLog.length; ahead += 1) {
    const behind = baseIndex.get(headLog[ahead]!.hash);
    if (behind !== undefined) {
      return { mergeBase: headLog[ahead]!, aheadBy: ahead, behindBy: behind };
    }
  }
  return null;
}

export async function compareCode(
  env: ArtifactsBindings,
  artifactsName: string,
  base: string,
  head: string,
  options: { direct?: boolean } = {},
): Promise<CodeComparison> {
  return withArtifactsRepo(env, artifactsName, async (repo) => {
    const [baseCommit, headCommit] = await Promise.all([
      resolveCommit(repo, base),
      resolveCommit(repo, head),
    ]);
    if (!headCommit) throw new CodeNotFoundError(`${head} not found`);
    const empty = {
      base,
      head,
      baseSha: baseCommit?.hash ?? null,
      headSha: headCommit.hash,
    };
    if (!baseCommit) {
      throw new CodeNotFoundError(`${base} not found`);
    }
    const [baseLog, headLog] = await Promise.all([
      repo.log({ ref: baseCommit.hash, limit: MAX_HISTORY }),
      repo.log({ ref: headCommit.hash, limit: MAX_HISTORY }),
    ]);
    const fork = forkPoint(baseLog, headLog);
    const commits = fork ? headLog.slice(0, fork.aheadBy) : headLog;
    // A direct comparison diffs the two commits as they are, which suits
    // alternative attempts that each started from a different base.
    const from = options.direct ? baseCommit : fork?.mergeBase ?? null;
    const diff = await diffRootTrees(repo, from?.treeHash ?? null, headCommit.treeHash);
    return {
      ...empty,
      mergeBase: fork?.mergeBase.hash ?? null,
      commits: commits.map(toCommit),
      aheadBy: fork?.aheadBy ?? headLog.length,
      behindBy: fork?.behindBy ?? baseLog.length,
      ...diff,
    };
  });
}

/** Ahead/behind counts and fork point of `head` against `base`, without a diff. */
export async function divergence(repo: ArtifactsRepo, base: string, head: string) {
  const [baseLog, headLog] = await Promise.all([
    repo.log({ ref: base, limit: MAX_HISTORY }),
    repo.log({ ref: head, limit: MAX_HISTORY }),
  ]);
  const fork = forkPoint(baseLog, headLog);
  return {
    baseSha: baseLog[0]?.hash ?? null,
    headSha: headLog[0]?.hash ?? null,
    mergeBase: fork?.mergeBase.hash ?? null,
    aheadBy: fork?.aheadBy ?? null,
    behindBy: fork?.behindBy ?? null,
  };
}

const MAX_LISTED_BRANCHES = 100;
const BRANCH_HISTORY = 300;

export async function listCodeBranches(
  env: ArtifactsBindings,
  artifactsName: string,
  refs: CodeRefs,
  isProtected: (branch: string) => boolean,
): Promise<CodeBranch[]> {
  return withArtifactsRepo(env, artifactsName, async (repo) => {
    const baseLog = await repo.log({ ref: refs.defaultBranch, limit: MAX_HISTORY });
    const baseIndex = new Map(baseLog.map((commit, index) => [commit.hash, index]));
    const listed = refs.branches.slice(0, MAX_LISTED_BRANCHES);
    const branches = await Promise.all(listed.map(async (branch): Promise<CodeBranch> => {
      const isDefault = branch.name === refs.defaultBranch;
      const history = await repo.log({
        ref: branch.hash,
        limit: isDefault ? 1 : BRANCH_HISTORY,
      });
      let aheadBy: number | null = isDefault ? 0 : null;
      let behindBy: number | null = isDefault ? 0 : null;
      if (!isDefault) {
        const ahead = history.findIndex((commit) => baseIndex.has(commit.hash));
        if (ahead >= 0) {
          aheadBy = ahead;
          behindBy = baseIndex.get(history[ahead]!.hash)!;
        }
      }
      return {
        name: branch.name,
        hash: branch.hash,
        commit: history[0] ? toCommit(history[0]) : null,
        isDefault,
        protected: isProtected(branch.name),
        aheadBy,
        behindBy,
      };
    }));
    return branches.sort((left, right) =>
      Number(right.isDefault) - Number(left.isDefault)
      || (right.commit?.committedAt ?? "").localeCompare(left.commit?.committedAt ?? "")
    );
  });
}

export async function listCodeTags(
  env: ArtifactsBindings,
  artifactsName: string,
  refs: CodeRefs,
): Promise<CodeTag[]> {
  return withArtifactsRepo(env, artifactsName, async (repo) => {
    const tags = await Promise.all(
      refs.tags.slice(0, MAX_LISTED_BRANCHES).map(async (tag) => {
        // Annotated tags point at tag objects; log peels them to the commit.
        const [commit] = await repo.log({ ref: `refs/tags/${tag.name}`, limit: 1 })
          .catch(() => []);
        return { name: tag.name, hash: tag.hash, commit: commit ? toCommit(commit) : null };
      }),
    );
    return tags.sort((left, right) =>
      (right.commit?.committedAt ?? "").localeCompare(left.commit?.committedAt ?? "")
      || right.name.localeCompare(left.name)
    );
  });
}

/** Tree reads are immutable by hash; share them across one history walk. */
function cachedTrees(repo: ArtifactsRepo) {
  const cache = new Map<string, Promise<ArtifactsTreeEntry[] | null>>();
  return (hash: string) => {
    let entries = cache.get(hash);
    if (!entries) {
      entries = repo.readTree(hash);
      cache.set(hash, entries);
    }
    return entries;
  };
}

/** Hash of the object at `segments` below `rootTree`, or null when absent. */
async function objectAt(
  readTree: (hash: string) => Promise<ArtifactsTreeEntry[] | null>,
  rootTree: string,
  segments: string[],
) {
  let hash = rootTree;
  for (const segment of segments) {
    const entry = (await readTree(hash))?.find((item) => item.name === segment);
    if (!entry) return null;
    hash = entry.hash;
  }
  return hash;
}

const ENTRY_HISTORY = 100;
const HISTORY_BATCH = 10;

async function inBatches<T, R>(items: T[], map: (item: T) => Promise<R>) {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += HISTORY_BATCH) {
    results.push(...await Promise.all(items.slice(index, index + HISTORY_BATCH).map(map)));
  }
  return results;
}

/** Finds the latest commit that changed each entry of a directory. */
export async function readEntryCommits(
  env: ArtifactsBindings,
  artifactsName: string,
  ref: string,
  path: string,
): Promise<CodeEntryCommits> {
  const segments = pathSegments(path);
  return withArtifactsRepo(env, artifactsName, async (repo) => {
    const history = await repo.log({ ref, limit: ENTRY_HISTORY + 1 });
    if (history.length === 0) return { commits: {}, partial: false };
    const readTree = cachedTrees(repo);
    const snapshots = await inBatches(history, async (commit) => {
      const directory = await objectAt(readTree, commit.treeHash, segments);
      const entries = directory ? await readTree(directory) : null;
      return new Map((entries ?? []).map((entry) => [entry.name, entry.hash]));
    });
    const pending = new Set(snapshots[0]!.keys());
    const commits: Record<string, CodeCommit> = {};
    for (let index = 0; index < history.length && pending.size; index += 1) {
      const commit = history[index]!;
      const next = snapshots[index + 1]
        ?? (commit.parents.length === 0 ? new Map<string, string>() : null);
      if (!next) break;
      for (const name of [...pending]) {
        if (snapshots[index]!.get(name) !== next.get(name)) {
          commits[name] = toCommit(commit);
          pending.delete(name);
        }
      }
    }
    return { commits, partial: pending.size > 0 };
  });
}

const PATH_HISTORY_SCAN = 200;

/** Commits that changed a path, resuming the first-parent scan at `offset`. */
export async function listPathCommits(
  env: ArtifactsBindings,
  artifactsName: string,
  ref: string,
  path: string,
  limit: number,
  offset: number,
) {
  const segments = pathSegments(path);
  return withArtifactsRepo(env, artifactsName, async (repo) => {
    const history = await repo.log({ ref, limit: PATH_HISTORY_SCAN + 1, offset });
    const readTree = cachedTrees(repo);
    const hashes = await inBatches(history, (commit) =>
      objectAt(readTree, commit.treeHash, segments)
    );
    const commits: CodeCommit[] = [];
    let index = 0;
    while (index < history.length && commits.length < limit) {
      const commit = history[index]!;
      let parentHash: string | null;
      if (index + 1 < history.length) parentHash = hashes[index + 1]!;
      else if (commit.parents.length === 0) parentHash = null;
      // The parent is on the next page; resume from this commit.
      else break;
      if (hashes[index] !== parentHash) commits.push(toCommit(commit));
      index += 1;
    }
    return {
      commits,
      nextOffset: index >= history.length ? null : offset + index,
    };
  });
}

const MAX_INDEXED_PATHS = 20_000;
const MAX_INDEXED_TREES = 2_000;

/** Every file path at a ref, for the file finder. */
export async function listCodeFiles(
  env: ArtifactsBindings,
  artifactsName: string,
  ref: string,
): Promise<CodeFileIndex> {
  return withArtifactsRepo(env, artifactsName, async (repo) => {
    const commit = await resolveCommit(repo, ref);
    if (!commit) return { paths: [], truncated: false };
    const paths: string[] = [];
    let level: Array<{ hash: string; prefix: string }> = [{ hash: commit.treeHash, prefix: "" }];
    let treesRead = 0;
    let truncated = false;
    while (level.length && !truncated) {
      if (treesRead + level.length > MAX_INDEXED_TREES) {
        level = level.slice(0, MAX_INDEXED_TREES - treesRead);
        truncated = true;
      }
      treesRead += level.length;
      const listings = await inBatches(level, async (tree) => ({
        prefix: tree.prefix,
        entries: await repo.readTree(tree.hash) ?? [],
      }));
      const next: typeof level = [];
      for (const { prefix, entries } of listings) {
        for (const entry of entries) {
          const path = `${prefix}${entry.name}`;
          if (entry.type === "tree") next.push({ hash: entry.hash, prefix: `${path}/` });
          else if (entry.type !== "gitlink") paths.push(path);
        }
      }
      if (paths.length > MAX_INDEXED_PATHS) {
        paths.length = MAX_INDEXED_PATHS;
        truncated = true;
      }
      level = next;
    }
    return { paths: paths.sort(), truncated };
  });
}
