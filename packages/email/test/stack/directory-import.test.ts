import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { required } from "@open-workspace/core/shared";
import { mcpAccessToken } from "@open-workspace/core/testing";
import { main } from "@open-workspace/create/import/cli.ts";

import { bootstrapAdmin } from "./mail-flow-helpers.ts";
import { env, useFreshWorkspace, worker } from "./workspace.ts";

useFreshWorkspace();

/**
 * `import people` against the stack, from a saved Google directory (the
 * Directory API itself cannot be reached here): members, alias mailboxes,
 * teams and their addresses through the admin API, and the invitation CSV.
 */

const origin = "http://example.test";

const directory = join(
  import.meta.dirname,
  "../../../create/test/fixtures/google-directory.json"
);

let token = "";

function deps(log: string[]) {
  return {
    fetch: (input: string, init?: RequestInit) =>
      worker.fetch(new Request(input, init)),
    credentialsPath: null,
    log: (line: string) => log.push(line),
  };
}

beforeAll(async () => {
  const cookie = await bootstrapAdmin();
  token = (
    await mcpAccessToken(cookie, {
      scope: "people.read admin.people admin.teams",
    })
  ).accessToken;
});

describe("directory import", () => {
  it("plans without changing anything, then creates people, mailboxes and teams once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ow-people-"));
    const invites = join(dir, "invites.csv");

    const args = [
      "people",
      "--from-directory",
      directory,
      "--workspace",
      origin,
      "--token",
      token,
      "--invites",
      invites,
    ];

    const planned: string[] = [];
    expect(await main([...args, "--dry-run"], deps(planned))).toBe(0);
    expect(planned).toContain("team     Studio (studio): 2 members");
    expect(planned.at(-1)).toBe("Dry run: 10 changes planned, none made.");
    expect(
      required(
        await env.DB.prepare("SELECT count(*) AS n FROM users").first<{
          n: number;
        }>(),
        "count(*) gives a row"
      ).n
    ).toBe(1);

    const log: string[] = [];
    expect(await main(args, deps(log)), log.join("\n")).toBe(0);
    expect(log.at(-1)).toBe("10 changes made, 0 failed.");

    const people = await env.DB.prepare(
      "SELECT name, status FROM users ORDER BY name"
    ).all<{ name: string; status: string }>();

    expect(people.results).toEqual([
      { name: "Ada Moss", status: "invited" },
      { name: "Admin", status: "active" },
      { name: "Juniper Vale", status: "invited" },
    ]);

    const mailboxes = await env.DB.prepare(`
      SELECT m.local_part AS local, m.delivery, m.list_posting AS posting, u.name AS owner, t.slug AS team
      FROM mailboxes m LEFT JOIN users u ON u.id = m.owner_user_id LEFT JOIN teams t ON t.id = m.team_id
      ORDER BY m.local_part`).all<Record<string, string | null>>();

    expect(mailboxes.results).toEqual([
      {
        local: "ada",
        delivery: "inbox",
        posting: "workspace",
        owner: "Ada Moss",
        team: null,
      },
      {
        local: "ada.moss",
        delivery: "inbox",
        posting: "workspace",
        owner: "Ada Moss",
        team: null,
      },
      {
        local: "admin",
        delivery: "inbox",
        posting: "workspace",
        owner: "Admin",
        team: null,
      },
      {
        local: "atelier",
        delivery: "list",
        posting: "members",
        owner: null,
        team: "studio",
      },
      {
        local: "help",
        delivery: "inbox",
        posting: "anyone",
        owner: null,
        team: "help",
      },
      {
        local: "juniper",
        delivery: "inbox",
        posting: "workspace",
        owner: "Juniper Vale",
        team: null,
      },
      {
        local: "kiln-crew",
        delivery: "list",
        posting: "workspace",
        owner: null,
        team: "kiln-crew",
      },
      {
        local: "studio",
        delivery: "list",
        posting: "members",
        owner: null,
        team: "studio",
      },
    ]);

    const teams = await env.DB.prepare(`
      SELECT t.slug, t.everyone, (SELECT count(*) FROM team_members tm WHERE tm.team_id = t.id) AS members
      FROM teams t ORDER BY t.slug`).all<{
      slug: string;
      everyone: number;
      members: number;
    }>();

    expect(teams.results).toEqual([
      // The workspace's own Everyone team, then the imported ones.
      { slug: "everyone", everyone: 1, members: 0 },
      { slug: "help", everyone: 1, members: 0 },
      { slug: "kiln-crew", everyone: 0, members: 1 },
      { slug: "studio", everyone: 0, members: 2 },
    ]);

    const csv = readFileSync(invites, "utf-8").trim().split("\n");
    expect(csv[0]).toBe("name,email,invitation_url,expires_at");
    expect(
      csv.slice(1).map((row) => row.split(",").slice(0, 2).join(","))
    ).toEqual([
      "Ada Moss,ada@example.test",
      "Juniper Vale,juniper@example.test",
    ]);
    expect(csv[1]).toMatch(/,http:\/\/example\.test\/invite\/[^,]+,/u);

    // Again: everything is there already.
    const again: string[] = [];
    expect(await main(args, deps(again))).toBe(0);
    expect(again.at(-1)).toBe("0 changes made, 0 failed.");
  });
});
