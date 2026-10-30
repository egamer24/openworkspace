import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { BranchProtectionRule } from "../shared/code";
import { createAccountApiToken } from "../worker/auth/api-tokens";
import { handleGitHttp, type GitHttpEnv } from "../worker/code/git-http";
import {
  pktLine,
  PktLineError,
  readReceivePackHead,
  rejectedReceivePackResult,
  FLUSH_PKT,
} from "../worker/code/pkt-line";
import { authorizeRefUpdates } from "../worker/code/ref-policy";
import {
  createRepository,
  deleteRepository,
  findRepository,
  listBranchProtections,
  replaceBranchProtections,
} from "../worker/code/repositories";
import { createDb } from "../worker/db/client";
import { users } from "../worker/db/schema";
import type { SessionUser } from "../worker/env";

const ZERO = "0".repeat(40);
const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const PACK = new TextEncoder().encode("PACK\x00\x00\x00\x02fake-pack-bytes");

function bytes(...parts: Uint8Array[]) {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function receivePackBody(
  commands: { oldOid: string; newOid: string; ref: string }[],
  capabilities = "report-status side-band-64k agent=git/2.50.0",
) {
  return bytes(
    ...commands.map((command, index) =>
      pktLine(
        `${command.oldOid} ${command.newOid} ${command.ref}`
          + (index === 0 ? `\0${capabilities}` : "")
          + "\n",
      )
    ),
    FLUSH_PKT,
    PACK,
  );
}

function streamOf(data: Uint8Array, chunkSize: number) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < data.byteLength; offset += chunkSize) {
        controller.enqueue(data.slice(offset, offset + chunkSize));
      }
      controller.close();
    },
  });
}

/** Decodes side-band channel 1 and returns the report-status lines. */
function reportLines(body: Uint8Array) {
  const decoder = new TextDecoder();
  const read = (data: Uint8Array) => {
    const packets: Uint8Array[] = [];
    let offset = 0;
    while (offset < data.byteLength) {
      const length = Number.parseInt(decoder.decode(data.subarray(offset, offset + 4)), 16);
      if (length === 0) {
        offset += 4;
        continue;
      }
      packets.push(data.subarray(offset + 4, offset + length));
      offset += length;
    }
    return packets;
  };
  const inner = bytes(...read(body).map((packet) => {
    expect(packet[0]).toBe(1);
    return packet.subarray(1);
  }));
  return read(inner).map((packet) => decoder.decode(packet).trimEnd());
}

const member: SessionUser = {
  id: "usr_member",
  name: "Member",
  avatarUrl: null,
  role: "member",
  status: "active",
};
const admin: SessionUser = { ...member, id: "usr_admin", name: "Admin", role: "admin" };

describe("receive-pack head", () => {
  it("parses commands split across chunks and keeps the pack bytes", async () => {
    const body = receivePackBody([
      { oldOid: OLD, newOid: NEW, ref: "refs/heads/main" },
      { oldOid: ZERO, newOid: NEW, ref: "refs/heads/feature/x" },
    ]);
    const head = await readReceivePackHead(streamOf(body, 7).getReader());
    expect(head.commands).toEqual([
      { oldOid: OLD, newOid: NEW, ref: "refs/heads/main" },
      { oldOid: ZERO, newOid: NEW, ref: "refs/heads/feature/x" },
    ]);
    expect(head.capabilities.has("side-band-64k")).toBe(true);
    expect(bytes(head.head, head.rest).byteLength).toBeLessThanOrEqual(body.byteLength);
    expect(new TextDecoder().decode(head.head).endsWith("0000")).toBe(true);
  });

  it("rejects signed pushes and malformed commands", async () => {
    const signed = bytes(pktLine("push-cert\0report-status\n"), FLUSH_PKT);
    await expect(readReceivePackHead(streamOf(signed, 64).getReader()))
      .rejects.toBeInstanceOf(PktLineError);
    const malformed = bytes(pktLine("nope\n"), FLUSH_PKT);
    await expect(readReceivePackHead(streamOf(malformed, 64).getReader()))
      .rejects.toBeInstanceOf(PktLineError);
  });

  it("reports every rejected ref inside side-band channel 1", () => {
    const commands = [{ oldOid: OLD, newOid: NEW, ref: "refs/heads/main" }];
    const result = rejectedReceivePackResult(
      commands,
      new Set(["report-status", "side-band-64k"]),
      new Map([["refs/heads/main", "protected"]]),
    );
    expect(reportLines(result!)).toEqual(["unpack ok", "ng refs/heads/main protected"]);
    expect(rejectedReceivePackResult(commands, new Set(), new Map())).toBeNull();
  });
});

describe("ref update policy", () => {
  const rules: BranchProtectionRule[] = [
    { pattern: "main", push: "admins", allowDeletion: false },
    { pattern: "release/*", push: "integration", allowDeletion: false },
    { pattern: "scratch/**", push: "members", allowDeletion: true },
  ];

  it("enforces branch rules before accepting a push", () => {
    const update = (ref: string, newOid = NEW, oldOid = OLD) => [{ oldOid, newOid, ref }];
    expect(authorizeRefUpdates(member, update("refs/heads/feature"), rules).size).toBe(0);
    expect(authorizeRefUpdates(member, update("refs/heads/main"), rules).get("refs/heads/main"))
      .toMatch(/administrator/u);
    expect(authorizeRefUpdates(admin, update("refs/heads/main"), rules).size).toBe(0);
    expect(authorizeRefUpdates(admin, update("refs/heads/main", ZERO), rules).size).toBe(1);
    expect(authorizeRefUpdates(admin, update("refs/heads/release/1.0"), rules).size).toBe(1);
    expect(authorizeRefUpdates(member, update("refs/heads/release/1.0/x"), rules).size).toBe(0);
    expect(authorizeRefUpdates(member, update("refs/heads/scratch/a/b", ZERO), rules).size)
      .toBe(0);
  });

  it("rejects the whole push when any ref is denied", () => {
    const reasons = authorizeRefUpdates(member, [
      { oldOid: OLD, newOid: NEW, ref: "refs/heads/feature" },
      { oldOid: OLD, newOid: NEW, ref: "refs/heads/main" },
    ], rules);
    expect(reasons.get("refs/heads/feature")).toBe("atomic push failed");
  });

  it("protects tags and reserved refs", () => {
    expect(authorizeRefUpdates(member, [{ oldOid: ZERO, newOid: NEW, ref: "refs/tags/v1" }], rules).size)
      .toBe(0);
    expect(authorizeRefUpdates(member, [{ oldOid: OLD, newOid: NEW, ref: "refs/tags/v1" }], rules).size)
      .toBe(1);
    expect(authorizeRefUpdates(admin, [{ oldOid: ZERO, newOid: NEW, ref: "refs/workspace/x" }], rules).size)
      .toBe(1);
  });
});

class FakeArtifacts {
  repos = new Map<string, { revoked: string[]; tokens: number }>();

  async create(name: string): Promise<ArtifactsCreateRepoResult> {
    if (this.repos.has(name)) {
      throw Object.assign(new Error("exists"), {
        name: "ArtifactsError",
        code: "ALREADY_EXISTS",
      });
    }
    this.repos.set(name, { revoked: [], tokens: 0 });
    return {
      id: `id-${name}`,
      name,
      description: null,
      defaultBranch: "main",
      remote: this.remote(name),
      token: "art_v1_initial?expires=1",
    };
  }

  async get(name: string) {
    const state = this.repos.get(name);
    if (!state) throw new Error("not found");
    const remote = this.remote(name);
    return {
      async info() {
        return { remote };
      },
      [Symbol.dispose]() {},
      async createToken(scope: "read" | "write", ttl: number) {
        state.tokens += 1;
        return {
          id: `tok-${state.tokens}`,
          plaintext: `art_v1_${scope}${state.tokens}?expires=9999999999`,
          scope,
          expiresAt: new Date(Date.now() + ttl * 1_000).toISOString(),
        };
      },
      async revokeToken(token: string) {
        state.revoked.push(token);
        return true;
      },
    };
  }

  async delete(name: string) {
    return this.repos.delete(name);
  }

  remote(name: string) {
    return `https://acct.artifacts.cloudflare.net/git/openworkspace/${name}.git`;
  }
}

describe("Git smart HTTP proxy", () => {
  const artifacts = new FakeArtifacts();
  const gitEnv = { DB: env.DB, ARTIFACTS: artifacts as unknown as Artifacts } satisfies GitHttpEnv;
  const db = createDb(env.DB);
  let memberToken = "";
  let adminToken = "";

  beforeAll(async () => {
    await db.insert(users).values([
      { id: "usr_git_member", name: "Git Member", role: "member", status: "active" },
      { id: "usr_git_admin", name: "Git Admin", role: "admin", status: "active" },
    ]);
    memberToken = (await createAccountApiToken(db, "usr_git_member", "git")).token;
    adminToken = (await createAccountApiToken(db, "usr_git_admin", "git")).token;
    await createRepository(gitEnv, db, "usr_git_admin", {
      name: "project",
      description: null,
      defaultBranch: "main",
    });
  });

  const basic = (token: string) => `Basic ${btoa(`git:${token}`)}`;

  function upstreamFetch() {
    return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const received = init?.body
        ? new Uint8Array(await new Response(init.body).arrayBuffer())
        : null;
      return new Response(received ?? "refs", {
        headers: {
          "content-type": "application/x-git-upload-pack-advertisement",
          "x-internal": "hidden",
        },
      });
    });
  }

  it("creates storage with a protected default branch and revokes the initial token", async () => {
    const record = await findRepository(db, "project");
    expect(record?.artifactsName).toBe("project");
    expect(await listBranchProtections(db, record!.id)).toEqual([
      { pattern: "main", push: "admins", allowDeletion: false },
    ]);
    expect(artifacts.repos.get("project")?.revoked).toEqual(["art_v1_initial?expires=1"]);
  });

  it("asks unauthenticated clients for credentials", async () => {
    const response = await handleGitHttp(
      new Request("http://example.test/project.git/info/refs?service=git-upload-pack"),
      gitEnv,
      { fetch: upstreamFetch() },
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Basic /u);
  });

  it("does not reveal missing repositories before authentication", async () => {
    const unauthenticated = await handleGitHttp(
      new Request("http://example.test/missing.git/info/refs?service=git-upload-pack"),
      gitEnv,
    );
    expect(unauthenticated.status).toBe(401);
    const authenticated = await handleGitHttp(
      new Request("http://example.test/missing.git/info/refs?service=git-upload-pack", {
        headers: { authorization: basic(memberToken) },
      }),
      gitEnv,
    );
    expect(authenticated.status).toBe(404);
  });

  it("forwards fetches with a server-side Artifacts credential", async () => {
    const fetchMock = upstreamFetch();
    const response = await handleGitHttp(
      new Request("http://example.test/project.git/info/refs?service=git-upload-pack", {
        headers: { authorization: basic(memberToken), "git-protocol": "version=2" },
      }),
      gitEnv,
      { fetch: fetchMock },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-internal")).toBeNull();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://acct.artifacts.cloudflare.net/git/openworkspace/project.git/info/refs?service=git-upload-pack",
    );
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toMatch(/^Basic /u);
    expect(atob(headers.get("authorization")!.slice(6))).toMatch(/^x:art_v1_read\d+$/u);
    expect(headers.get("git-protocol")).toBe("version=2");
  });

  it("rejects a member push to the protected branch without contacting storage", async () => {
    const fetchMock = upstreamFetch();
    const response = await handleGitHttp(
      new Request("http://example.test/project.git/git-receive-pack", {
        method: "POST",
        headers: {
          authorization: basic(memberToken),
          "content-type": "application/x-git-receive-pack-request",
        },
        body: receivePackBody([{ oldOid: OLD, newOid: NEW, ref: "refs/heads/main" }]),
      }),
      gitEnv,
      { fetch: fetchMock },
    );
    expect(response.status).toBe(200);
    expect(reportLines(new Uint8Array(await response.arrayBuffer()))).toEqual([
      "unpack ok",
      "ng refs/heads/main protected branch requires an administrator",
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("streams allowed pushes unchanged, including gzip bodies", async () => {
    const body = receivePackBody([{ oldOid: ZERO, newOid: NEW, ref: "refs/heads/feature" }]);
    for (const gzip of [false, true]) {
      const fetchMock = upstreamFetch();
      const requestBody = gzip
        ? streamOf(body, 5).pipeThrough(
          new CompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
        )
        : streamOf(body, 5);
      const response = await handleGitHttp(
        new Request("http://example.test/project.git/git-receive-pack", {
          method: "POST",
          headers: {
            authorization: `Bearer ${memberToken}`,
            "content-type": "application/x-git-receive-pack-request",
            ...(gzip ? { "content-encoding": "gzip" } : {}),
          },
          body: requestBody,
        }),
        gitEnv,
        { fetch: fetchMock },
      );
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
      const headers = new Headers(fetchMock.mock.calls[0]![1]?.headers);
      expect(headers.get("content-encoding")).toBeNull();
      expect(atob(headers.get("authorization")!.slice(6))).toMatch(/^x:art_v1_write\d+$/u);
    }
  });

  it("applies updated protection rules to administrators", async () => {
    const record = await findRepository(db, "project");
    await replaceBranchProtections(db, record!.id, [
      { pattern: "main", push: "integration", allowDeletion: false },
    ]);
    const fetchMock = upstreamFetch();
    const response = await handleGitHttp(
      new Request("http://example.test/project.git/git-receive-pack", {
        method: "POST",
        headers: { authorization: basic(adminToken) },
        body: receivePackBody([{ oldOid: OLD, newOid: NEW, ref: "refs/heads/main" }]),
      }),
      gitEnv,
      { fetch: fetchMock },
    );
    expect(reportLines(new Uint8Array(await response.arrayBuffer()))[1])
      .toMatch(/integration queue/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes Git paths through the Worker entry point", async () => {
    const response = await exports.default.fetch(
      new Request("http://example.test/project.git/info/refs?service=git-upload-pack"),
    );
    expect(response.status).toBe(401);
  });

  it("deletes storage and metadata together", async () => {
    await createRepository(gitEnv, db, "usr_git_admin", {
      name: "short-lived",
      description: "temp",
      defaultBranch: "trunk",
    });
    const record = await findRepository(db, "short-lived");
    await deleteRepository(gitEnv, db, record!);
    expect(await findRepository(db, "short-lived")).toBeNull();
    expect(artifacts.repos.has("short-lived")).toBe(false);
  });
});
