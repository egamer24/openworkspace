import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  compareCode,
  listCodeFiles,
  listPathCommits,
  listRefs,
  parseRefAdvertisement,
  readCodeBlob,
  readCodeCommit,
  readCodeTree,
  readEntryCommits,
} from "../worker/code/browse";
import { languageOf, readLanguages } from "../worker/code/languages";
import { FLUSH_PKT, pktLine } from "../worker/code/pkt-line";
import {
  createRepository,
  replaceBranchProtections,
} from "../worker/code/repositories";
import { createDb } from "../worker/db/client";
import { taskAttempts, users, type CodeRepositoryRecord } from "../worker/db/schema";
import type { SessionUser } from "../worker/env";
import {
  addNote,
  addReview,
  createTask,
  getTask,
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
} from "../worker/tasks/service";
import { eq } from "drizzle-orm";

const encoder = new TextEncoder();
const hex = (seed: string) => seed.repeat(40).slice(0, 40);

/** In-memory Git object store shaped like the Artifacts repo handle. */
class FakeRepo {
  trees = new Map<string, ArtifactsTreeEntry[]>();
  blobs = new Map<string, Uint8Array>();
  commits = new Map<string, ArtifactsCommitMetadata>();
  refs = new Map<string, string>();

  async info() {
    return { remote: "https://artifacts.example/git/ns/demo.git" };
  }
  [Symbol.dispose]() {}
  async createToken(scope: "read" | "write") {
    return {
      id: "t",
      plaintext: `art_v1_${scope}?expires=1`,
      scope,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
  }
  async revokeToken() {
    return true;
  }
  async readTree(hash: string) {
    return this.trees.get(hash) ?? null;
  }
  async readBlob(hash: string) {
    const bytes = this.blobs.get(hash);
    return bytes ? new Blob([bytes as Uint8Array<ArrayBuffer>]) : null;
  }
  async readCommit(hash: string) {
    return this.commits.get(hash) ?? null;
  }
  async log({ ref = "HEAD", limit = 50, offset = 0 } = {}) {
    let hash = this.refs.get(ref) ?? (this.commits.has(ref) ? ref : undefined);
    const history: ArtifactsCommitMetadata[] = [];
    while (hash) {
      const commit = this.commits.get(hash)!;
      history.push(commit);
      hash = commit.parents[0];
    }
    return history.slice(offset, offset + limit);
  }
  async readFile() {
    return null;
  }
}

function commit(
  repo: FakeRepo,
  hash: string,
  treeHash: string,
  parents: string[],
  message: string,
) {
  repo.commits.set(hash, {
    hash,
    treeHash,
    message,
    author: { name: "Dev", email: "dev@example.test" },
    committer: { name: "Dev", email: "dev@example.test" },
    parents,
    authoredAt: 1_790_000_000,
    committedAt: 1_790_000_000,
  });
}

function buildRepo() {
  const repo = new FakeRepo();
  repo.blobs.set(hex("1"), encoder.encode("# Demo\n"));
  repo.blobs.set(hex("2"), encoder.encode("export const a = 1;\n"));
  repo.blobs.set(hex("3"), encoder.encode("export const a = 2;\nexport const b = 3;\n"));
  repo.blobs.set(hex("4"), Uint8Array.of(0x89, 0x50, 0x00, 0x01));
  repo.trees.set(hex("a"), [{ name: "index.ts", mode: "100644", hash: hex("2"), type: "blob" }]);
  repo.trees.set(hex("b"), [
    { name: "index.ts", mode: "100644", hash: hex("3"), type: "blob" },
    { name: "logo.png", mode: "100644", hash: hex("4"), type: "blob" },
  ]);
  repo.trees.set(hex("c"), [
    { name: "README.md", mode: "100644", hash: hex("1"), type: "blob" },
    { name: "src", mode: "40000", hash: hex("a"), type: "tree" },
  ]);
  repo.trees.set(hex("d"), [
    { name: "README.md", mode: "100644", hash: hex("1"), type: "blob" },
    { name: "src", mode: "40000", hash: hex("b"), type: "tree" },
  ]);
  commit(repo, hex("e"), hex("c"), [], "Initial commit");
  commit(repo, hex("f"), hex("d"), [hex("e")], "Change source");
  repo.refs.set("main", hex("f"));
  return repo;
}

function bindingFor(repo: FakeRepo) {
  return {
    ARTIFACTS: {
      async get() {
        return repo;
      },
      async create(name: string) {
        return {
          id: name,
          name,
          description: null,
          defaultBranch: "main",
          remote: "https://artifacts.example/git/ns/demo.git",
          token: "art_v1_initial?expires=1",
        };
      },
      async delete() {
        return true;
      },
    } as unknown as Artifacts,
  };
}

describe("repository browsing", () => {
  const repo = buildRepo();
  const binding = bindingFor(repo);

  it("parses branches, tags, and HEAD from the ref advertisement", async () => {
    const advertisement = new Uint8Array([
      ...pktLine("# service=git-upload-pack\n"),
      ...FLUSH_PKT,
      ...pktLine(`${hex("f")} HEAD\0multi_ack symref=HEAD:refs/heads/trunk agent=x\n`),
      ...pktLine(`${hex("f")} refs/heads/trunk\n`),
      ...pktLine(`${hex("e")} refs/heads/feature/a\n`),
      ...pktLine(`${hex("1")} refs/tags/v1\n`),
      ...pktLine(`${hex("e")} refs/tags/v1^{}\n`),
      ...FLUSH_PKT,
    ]);
    expect(parseRefAdvertisement(advertisement).head).toBe("refs/heads/trunk");
    const refs = await listRefs(binding, "demo", "main", async (url, init) => {
      expect(url).toBe("https://artifacts.example/git/ns/demo.git/info/refs?service=git-upload-pack");
      expect(new Headers(init?.headers).get("authorization")).toMatch(/^Basic /u);
      return new Response(advertisement);
    });
    expect(refs).toEqual({
      defaultBranch: "trunk",
      branches: [{ name: "feature/a", hash: hex("e") }, { name: "trunk", hash: hex("f") }],
      tags: [{ name: "v1", hash: hex("1") }],
    });
  });

  it("lists directories first and walks nested paths", async () => {
    const root = await readCodeTree(binding, "demo", "main", "");
    expect(root.entries.map((entry) => entry.name)).toEqual(["src", "README.md"]);
    expect(root.commit?.message).toBe("Change source");
    expect(root.commit?.authoredAt).toBe("2026-09-21T14:13:20.000Z");
    const src = await readCodeTree(binding, "demo", hex("e"), "src");
    expect(src.entries.map((entry) => entry.name)).toEqual(["index.ts"]);
    await expect(readCodeTree(binding, "demo", "main", "src/../x")).rejects.toThrow();
  });

  it("returns text and flags binary files", async () => {
    const text = await readCodeBlob(binding, "demo", "main", "src/index.ts");
    expect(text).toMatchObject({ kind: "text", text: "export const a = 2;\nexport const b = 3;\n" });
    const binary = await readCodeBlob(binding, "demo", "main", "src/logo.png");
    expect(binary).toMatchObject({ kind: "binary", text: null });
    await expect(readCodeBlob(binding, "demo", "main", "src")).rejects.toThrow();
  });

  it("diffs a commit against its first parent", async () => {
    const detail = await readCodeCommit(binding, "demo", hex("f"));
    expect(detail.files.map((file) => [file.path, file.status])).toEqual([
      ["src/index.ts", "modified"],
      ["src/logo.png", "added"],
    ]);
    expect(detail.files[0]).toMatchObject({ additions: 2, deletions: 1 });
    expect(detail.files[0]!.patch).toContain("-export const a = 1;");
    expect(detail.files[1]!.note).toBe("Binary file");
    const initial = await readCodeCommit(binding, "demo", hex("e"));
    expect(initial.files.map((file) => file.status)).toEqual(["added", "added"]);
  });
});

describe("history and comparison", () => {
  const repo = buildRepo();
  const binding = bindingFor(repo);
  // feature forks from the initial commit and adds a docs file.
  repo.blobs.set(hex("5"), encoder.encode("Docs\n"));
  repo.trees.set(hex("6"), [
    { name: "README.md", mode: "100644", hash: hex("1"), type: "blob" },
    { name: "docs.md", mode: "100644", hash: hex("5"), type: "blob" },
    { name: "src", mode: "40000", hash: hex("a"), type: "tree" },
  ]);
  commit(repo, hex("7"), hex("6"), [hex("e")], "Add docs");
  repo.refs.set("feature", hex("7"));

  it("compares a branch against where it forked", async () => {
    const comparison = await compareCode(binding, "demo", "main", "feature");
    expect(comparison).toMatchObject({
      mergeBase: hex("e"),
      aheadBy: 1,
      behindBy: 1,
      baseSha: hex("f"),
      headSha: hex("7"),
    });
    expect(comparison.commits.map((item) => item.message)).toEqual(["Add docs"]);
    // Only the branch's own change, not main's newer commit.
    expect(comparison.files.map((file) => [file.path, file.status])).toEqual([
      ["docs.md", "added"],
    ]);
    const direct = await compareCode(binding, "demo", "main", "feature", { direct: true });
    expect(direct.files.map((file) => file.path)).toEqual(["docs.md", "src/index.ts", "src/logo.png"]);
  });

  it("finds the last commit per entry and the history of a path", async () => {
    const entries = await readEntryCommits(binding, "demo", "main", "");
    expect(entries.partial).toBe(false);
    expect(entries.commits["README.md"]?.message).toBe("Initial commit");
    expect(entries.commits.src?.message).toBe("Change source");
    const history = await listPathCommits(binding, "demo", "main", "src/index.ts", 10, 0);
    expect(history.commits.map((item) => item.message)).toEqual(["Change source", "Initial commit"]);
    expect(history.nextOffset).toBeNull();
    const readme = await listPathCommits(binding, "demo", "main", "README.md", 10, 0);
    expect(readme.commits.map((item) => item.message)).toEqual(["Initial commit"]);
  });

  it("measures languages by bytes and skips data and vendored files", async () => {
    expect(languageOf("src/app.tsx")?.name).toBe("TypeScript");
    expect(languageOf("Dockerfile.prod")?.name).toBe("Dockerfile");
    expect(languageOf("README.md")).toBeNull();
    expect(languageOf("types.d.ts")).toBeNull();
    repo.blobs.set(hex("b1"), encoder.encode("echo hi\n"));
    repo.trees.set(hex("b2"), [
      { name: "index.js", mode: "100644", hash: hex("2"), type: "blob" },
    ]);
    repo.trees.set(hex("b3"), [
      { name: "README.md", mode: "100644", hash: hex("1"), type: "blob" },
      { name: "node_modules", mode: "40000", hash: hex("b2"), type: "tree" },
      { name: "run.sh", mode: "100755", hash: hex("b1"), type: "exec" },
      { name: "src", mode: "40000", hash: hex("b"), type: "tree" },
    ]);
    commit(repo, hex("b4"), hex("b3"), [hex("f")], "Add script");
    const result = await readLanguages(binding, "demo", hex("b4"));
    expect(result.partial).toBe(false);
    expect(result.languages.map((item) => [item.name, item.bytes])).toEqual([
      ["TypeScript", 40],
      ["Shell", 8],
    ]);
    expect(result.languages[0]!.percent).toBeCloseTo(83.33, 1);
  });

  it("lists every file for the finder", async () => {
    expect(await listCodeFiles(binding, "demo", "main")).toEqual({
      paths: ["README.md", "src/index.ts", "src/logo.png"],
      truncated: false,
    });
  });
});

/** Answers receive-pack requests like Artifacts, moving refs with compare-and-swap. */
function receivePackServer(repo: FakeRepo, requests: string[]) {
  return async (url: string, init?: RequestInit) => {
    expect(url).toMatch(/\/git-receive-pack$/u);
    const body = new Uint8Array(init!.body as Uint8Array);
    const text = new TextDecoder().decode(body);
    requests.push(text);
    const [, oldOid, newOid, ref] = text.match(/^[0-9a-f]{4}([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\0/u)!;
    const name = ref!.replace("refs/heads/", "");
    const current = repo.refs.get(name) ?? "0".repeat(40);
    const lines = [pktLine("unpack ok\n")];
    if (current !== oldOid) {
      lines.push(pktLine(`ng ${ref} stale info\n`));
    } else {
      if (/^0+$/u.test(newOid!)) repo.refs.delete(name);
      else repo.refs.set(name, newOid!);
      lines.push(pktLine(`ok ${ref}\n`));
    }
    return new Response(new Uint8Array([...lines.flatMap((line) => [...line]), ...FLUSH_PKT]));
  };
}

describe("tasks", () => {
  const db = createDb(env.DB);
  const repo = buildRepo();
  const binding = bindingFor(repo);
  const alice: SessionUser = {
    id: "usr_task_alice",
    name: "Alice",
    avatarUrl: null,
    role: "member",
    status: "active",
  };
  const bob: SessionUser = { ...alice, id: "usr_task_bob", name: "Bob" };
  let repository: CodeRepositoryRecord;
  let other: CodeRepositoryRecord;

  beforeAll(async () => {
    await db.insert(users).values([
      { id: alice.id, name: alice.name, role: "member", status: "active" },
      { id: bob.id, name: bob.name, role: "member", status: "active" },
    ]);
    repository = await createRepository(binding, db, alice.id, {
      name: "tasks-demo",
      description: null,
      defaultBranch: "main",
    });
    other = await createRepository(binding, db, alice.id, {
      name: "tasks-other",
      description: null,
      defaultBranch: "main",
    });
  });

  const input = (title: string, dependsOn: number[] = []) => ({
    title,
    goal: "Goal",
    acceptanceCriteria: "Tests pass",
    scope: "",
    baseBranch: null,
    dependsOn,
  });

  it("numbers tasks per repository and blocks work on unmerged dependencies", async () => {
    const schema = await createTask(binding, db, alice, repository, input("Schema"));
    const api = await createTask(binding, db, alice, repository, input("API", [schema.number]));
    expect(schema.number).toBe(1);
    expect(api.number).toBe(2);
    expect((await createTask(binding, db, alice, other, input("Elsewhere"))).number).toBe(1);
    expect(api.blocked).toBe(true);
    expect(api.baseBranch).toBe("main");
    await expect(createTask(binding, db, alice, other, input("Cross", [api.number])))
      .rejects.toThrow(/not found/u);
    await expect(startAttempt(binding, db, bob, repository, api.number)).rejects.toThrow(/blocked/u);
    await expect(updateTask(db, repository, schema.number, { dependsOn: [api.number] }))
      .rejects.toThrow(/cycle/u);

    const started = await startAttempt(binding, db, bob, repository, schema.number);
    expect(started.status).toBe("in_progress");
    expect(started.attempts[0]).toMatchObject({
      number: 1,
      status: "active",
      branch: "tasks/1-1",
      baseSha: hex("f"),
      current: true,
    });
    expect((await listTasks(db, repository)).map((task) => task.number)).toEqual([2, 1]);
  });

  it("keeps a late result separate from the attempt that took over", async () => {
    const task = await createTask(binding, db, alice, repository, input("Delivery"));
    await startAttempt(binding, db, alice, repository, task.number);
    await expect(startAttempt(binding, db, bob, repository, task.number))
      .rejects.toThrow(/already claimed/u);

    // Alice disappears: her lease lapses and Bob takes over.
    await db
      .update(taskAttempts)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(taskAttempts.branch, `tasks/${task.number}-1`));
    await startAttempt(binding, db, bob, repository, task.number);
    await expect(renewLease(db, alice, repository, task.number, 1)).rejects.toThrow(/lease was lost/u);
    await expect(submitAttempt(binding, db, alice, repository, task.number, 2, { headSha: hex("e") }))
      .rejects.toBeInstanceOf(TaskError);

    const late = await submitAttempt(binding, db, alice, repository, task.number, 1, {
      headSha: hex("e"),
      summary: "Late but complete",
    });
    expect(late.status).toBe("in_progress");
    expect(late.attempts.map((attempt) => [attempt.number, attempt.status, attempt.current]))
      .toEqual([[2, "active", true], [1, "submitted", false]]);

    // Without a SHA the attempt branch tip is used; it must exist.
    await expect(submitAttempt(binding, db, bob, repository, task.number, 2, {}))
      .rejects.toThrow(/Push tasks\/3-2/u);
    await expect(submitAttempt(binding, db, bob, repository, task.number, 2, { headSha: hex("9") }))
      .rejects.toThrow(/not in the repository/u);
    repo.refs.set(`tasks/${task.number}-2`, hex("f"));
    const done = await submitAttempt(binding, db, bob, repository, task.number, 2, { summary: "Ready" });
    expect(done.status).toBe("in_review");
    expect(done.headSha).toBe(hex("f"));
    // Retrying the same submission is idempotent.
    const retried = await submitAttempt(binding, db, bob, repository, task.number, 2, {
      headSha: hex("f"),
    });
    expect(retried.attempts.filter((attempt) => attempt.status === "submitted")).toHaveLength(2);
    expect(retried.attempts[0]?.summary).toBe("Ready");
  });

  it("hands work back with context and tracks open questions", async () => {
    const task = await createTask(binding, db, alice, repository, input("Push delivery"));
    await startAttempt(binding, db, alice, repository, task.number);
    await renewLease(db, alice, repository, task.number, 1);
    const released = await releaseAttempt(db, alice, repository, task.number, 1, {
      summary: "Done: provider. Remaining: retries.",
    });
    expect(released.status).toBe("open");
    expect(released.assignee).toBeNull();
    expect(released.attempts[0]?.summary).toContain("Remaining");

    const asked = await addNote(db, bob, repository, task.number, {
      kind: "question",
      body: "Which provider?",
    });
    expect(asked.openQuestions).toBe(1);
    const resolved = await setNoteResolved(db, repository, task.number, asked.notes[0]!.id, true);
    expect(resolved.openQuestions).toBe(0);
    expect((await getTask(db, repository, task.number)).notes[0]?.resolvedAt).not.toBeNull();
  });

  it("reviews exact commits and fast-forwards the base branch", async () => {
    const mergeRepo = buildRepo();
    const mergeBinding = bindingFor(mergeRepo);
    const requests: string[] = [];
    const fetcher = receivePackServer(mergeRepo, requests);
    const record = await createRepository(mergeBinding, db, alice.id, {
      name: "merge-demo",
      description: null,
      defaultBranch: "main",
    });
    await replaceBranchProtections(db, record.id, [
      { pattern: "main", push: "integration", allowDeletion: false },
    ]);
    // Work on a branch that already exists, like opening a pull request.
    commit(mergeRepo, hex("8"), hex("d"), [hex("f")], "Feature");
    mergeRepo.refs.set("feature", hex("8"));
    const task = await createTask(mergeBinding, db, bob, record, {
      ...input("Feature"),
      fromBranch: "feature",
    });
    expect(task).toMatchObject({ status: "in_review", headSha: hex("8"), branch: "feature" });

    let state = await taskMergeability(mergeBinding, db, bob, record, task.number);
    expect(state.canMerge).toBe(false);
    expect(state.checks.find((check) => check.id === "up_to_date")).toMatchObject({ ok: true });
    expect(state.checks.find((check) => check.id === "approval")).toMatchObject({ ok: false });
    await expect(addReview(db, bob, record, task.number, { verdict: "approve", body: "" }))
      .rejects.toThrow(/own result/u);
    await expect(mergeTask(mergeBinding, db, bob, record, task.number, {
      bypassReview: true,
      deleteBranch: false,
    }, fetcher)).rejects.toThrow(/approval required/u);

    await addReview(db, alice, record, task.number, { verdict: "approve", body: "" });
    await addNote(db, alice, record, task.number, { kind: "question", body: "Docs?" });
    state = await taskMergeability(mergeBinding, db, bob, record, task.number);
    expect(state.checks.filter((check) => !check.ok).map((check) => check.id)).toEqual(["questions"]);
    const withQuestion = await getTask(db, record, task.number);
    await setNoteResolved(db, record, task.number, withQuestion.notes[0]!.id, true);

    // A new revision makes the approval outdated.
    commit(mergeRepo, hex("9"), hex("d"), [hex("8")], "Feature, revised");
    mergeRepo.refs.set("feature", hex("9"));
    const revised = await submitAttempt(mergeBinding, db, bob, record, task.number, 1, {});
    expect(revised.reviews[0]?.stale).toBe(true);
    expect(revised.reviewState).toBeNull();
    await addReview(db, alice, record, task.number, { verdict: "approve", body: "" });

    // Someone else moves main first: the result is no longer a fast-forward.
    commit(mergeRepo, hex("a1"), hex("d"), [hex("f")], "Hotfix");
    mergeRepo.refs.set("main", hex("a1"));
    state = await taskMergeability(mergeBinding, db, bob, record, task.number);
    expect(state.checks.find((check) => check.id === "up_to_date")?.label).toMatch(/1 commit behind/u);
    mergeRepo.refs.set("main", hex("f"));

    const merged = await mergeTask(mergeBinding, db, bob, record, task.number, {
      bypassReview: false,
      deleteBranch: true,
    }, fetcher);
    expect(merged.status).toBe("merged");
    expect(merged.merged).toMatchObject({ sha: hex("9"), by: { id: bob.id } });
    expect(merged.attempts[0]).toMatchObject({ status: "merged", baseSha: hex("f") });
    expect(mergeRepo.refs.get("main")).toBe(hex("9"));
    // Server updates carry an empty pack; deletes carry none. Only task
    // branches are cleaned up, so `feature` stays.
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain(`${hex("f")} ${hex("9")} refs/heads/main`);
    expect(requests[0]).toContain("PACK");
    expect(mergeRepo.refs.get("feature")).toBe(hex("9"));
  });
});
