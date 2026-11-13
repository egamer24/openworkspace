import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { z } from "zod";

import {
  googleAccessToken,
  postingPolicy,
  readGoogleDirectory,
} from "../../import/directory/google.ts";
import {
  describePlan,
  directorySchema,
  planDirectory,
  teamSlug,
} from "../../import/directory/plan.ts";
import type { WorkspaceState } from "../../import/directory/plan.ts";
import { required } from "../../import/invariant.ts";

const directory = directorySchema.parse(
  await Bun.file(
    join(import.meta.dirname, "../fixtures/google-directory.json")
  ).json()
);

const emptyWorkspace: WorkspaceState = {
  mailDomains: ["example.test"],
  users: [
    {
      id: "usr_admin",
      name: "Admin",
      personalEmail: "admin@example.test",
      status: "active",
    },
  ],
  mailboxes: [
    {
      id: "mbx_admin",
      address: "admin@example.test",
      ownerUserId: "usr_admin",
      teamId: null,
    },
  ],
  teams: [],
};

describe("directory plan", () => {
  it("invites people with their aliases and makes groups teams with their addresses", () => {
    const plan = planDirectory(directory, emptyWorkspace, {
      includeSuspended: false,
      groupDelivery: "list",
    });

    expect(plan.actions).toEqual([
      { kind: "invite", name: "Ada Moss", email: "ada@example.test" },
      {
        kind: "alias",
        ownerEmail: "ada@example.test",
        address: "ada.moss@example.test",
        displayName: "Ada Moss",
      },
      { kind: "invite", name: "Juniper Vale", email: "juniper@example.test" },
      // Nested groups are flattened; suspended and outside people are left out.
      {
        kind: "team",
        slug: "studio",
        name: "Studio",
        description: "The studio team",
        everyone: false,
        memberEmails: ["ada@example.test", "juniper@example.test"],
      },
      {
        kind: "team-mailbox",
        teamSlug: "studio",
        address: "studio@example.test",
        displayName: "Studio",
        delivery: "list",
        listPosting: "members",
      },
      {
        kind: "team-mailbox",
        teamSlug: "studio",
        address: "atelier@example.test",
        displayName: "Studio",
        delivery: "list",
        listPosting: "members",
      },
      {
        kind: "team",
        slug: "kiln-crew",
        name: "Kiln crew",
        description: null,
        everyone: false,
        memberEmails: ["juniper@example.test"],
      },
      {
        kind: "team-mailbox",
        teamSlug: "kiln-crew",
        address: "kiln-crew@example.test",
        displayName: "Kiln crew",
        delivery: "list",
        listPosting: "workspace",
      },
      {
        kind: "team",
        slug: "help",
        name: "Help desk",
        description: null,
        everyone: true,
        memberEmails: [],
      },
      {
        kind: "team-mailbox",
        teamSlug: "help",
        address: "help@example.test",
        displayName: "Help desk",
        delivery: "inbox",
        listPosting: "anyone",
      },
    ]);
    expect(plan.skipped).toEqual([
      {
        what: "ada@elsewhere.example",
        reason: "alias of ada@example.test in another domain",
      },
      { what: "rowan@example.test", reason: "suspended" },
      {
        what: "kit@other-company.example",
        reason:
          "other-company.example is not one of the workspace's mail domains",
      },
      {
        what: "studio@example.test members",
        reason: "not people here: guest@visitor.example",
      },
      {
        what: "kiln-crew@example.test members",
        reason: "not people here: rowan@example.test",
      },
    ]);
    expect(plan.administrators).toEqual(["ada@example.test"]);
    expect(describePlan(plan)).toContain(
      "invite   Ada Moss <ada@example.test> (with a personal mailbox)"
    );
  });

  it("leaves what the workspace has, so it can run again", () => {
    const workspace: WorkspaceState = {
      ...emptyWorkspace,
      users: [
        ...emptyWorkspace.users,
        {
          id: "usr_ada",
          name: "Ada",
          personalEmail: "ada@example.test",
          status: "invited",
        },
      ],
      mailboxes: [
        ...emptyWorkspace.mailboxes,
        {
          id: "mbx_ada",
          address: "ada@example.test",
          ownerUserId: "usr_ada",
          teamId: null,
        },
        {
          id: "mbx_studio",
          address: "studio@example.test",
          ownerUserId: null,
          teamId: "team_studio",
        },
      ],
      teams: [{ id: "team_studio", slug: "studio", name: "Studio" }],
    };

    const plan = planDirectory(directory, workspace, {
      includeSuspended: true,
      groupDelivery: "inbox",
    });

    expect(plan.existing).toEqual([
      "ada@example.test",
      "team studio",
      "studio@example.test",
    ]);
    expect(
      plan.actions
        .filter((action) => action.kind === "invite")
        .map((action) => "email" in action && action.email)
    ).toEqual(["juniper@example.test", "rowan@example.test"]);
    expect(
      plan.actions.find(
        (action) =>
          action.kind === "team-mailbox" &&
          action.address === "kiln-crew@example.test"
      )
    ).toMatchObject({ delivery: "inbox" });
  });

  it("makes team handles from group addresses", () => {
    expect(teamSlug("Kiln.Crew+2026@example.test")).toBe("kiln-crew-2026");
    expect(teamSlug("x@example.test")).toBe("team-x");
  });

  it("maps Google's posting settings", () => {
    expect(postingPolicy("ANYONE_CAN_POST")).toBe("anyone");
    expect(postingPolicy("ALL_IN_DOMAIN_CAN_POST")).toBe("workspace");
    expect(postingPolicy("ALL_MEMBERS_CAN_POST")).toBe("members");
    expect(postingPolicy(undefined)).toBeNull();
  });
});

describe("Google Directory API", () => {
  it("signs a service account's assertion and pages through users, groups and members", async () => {
    const keys = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"]
    );

    const pkcs8 = Buffer.from(
      await crypto.subtle.exportKey("pkcs8", keys.privateKey)
    ).toString("base64");

    const requests: string[] = [];

    const fetchImpl = async (input: string, init?: RequestInit) => {
      requests.push(input);
      const url = new URL(input);

      if (url.hostname === "oauth2.googleapis.com") {
        const assertion = required(
          new URLSearchParams(String(init?.body)).get("assertion"),
          "the token request's assertion"
        );

        const [header, claims = "", signature = ""] = assertion.split(".");

        const valid = await crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          keys.publicKey,
          Buffer.from(signature, "base64url"),
          new TextEncoder().encode(`${header}.${claims}`)
        );

        const body = z
          .object({ iss: z.string(), sub: z.string(), scope: z.string() })
          .parse(JSON.parse(Buffer.from(claims, "base64url").toString()));

        expect(valid).toBe(true);
        expect(body).toMatchObject({
          iss: "importer@project.iam.example",
          sub: "ada@example.test",
        });
        expect(body.scope).toContain("admin.directory.user.readonly");

        return Response.json({ access_token: "google-token" });
      }

      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer google-token"
      );

      if (url.pathname.endsWith("/users")) {
        return Response.json(
          url.searchParams.get("pageToken")
            ? {
                users: [
                  {
                    primaryEmail: "juniper@example.test",
                    name: { fullName: "Juniper Vale" },
                    suspended: true,
                  },
                ],
              }
            : {
                users: [
                  {
                    primaryEmail: "ada@example.test",
                    name: { fullName: "Ada Moss" },
                    aliases: ["a@example.test"],
                    isAdmin: true,
                  },
                ],
                nextPageToken: "2",
              }
        );
      }

      if (url.pathname.endsWith("/groups")) {
        return Response.json({
          groups: [{ email: "studio@example.test", name: "Studio" }],
        });
      }

      if (url.pathname.endsWith("/members")) {
        return Response.json({
          members: [
            { email: "ada@example.test", type: "USER" },
            { type: "CUSTOMER", id: "C01" },
          ],
        });
      }

      return Response.json({
        whoCanPostMessage: "ALL_IN_DOMAIN_CAN_POST",
        enableCollaborativeInbox: "true",
      });
    };

    const token = await googleAccessToken({
      credentials: {
        type: "service_account",
        client_email: "importer@project.iam.example",
        private_key: `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----\n`,
      },
      admin: "ada@example.test",
      groupSettings: true,
      fetch: fetchImpl,
      openBrowser: () => {},
      log: () => {},
    });

    const read = await readGoogleDirectory(token, {
      groupSettings: true,
      fetch: fetchImpl,
    });

    expect(read).toEqual({
      users: [
        {
          email: "ada@example.test",
          name: "Ada Moss",
          aliases: ["a@example.test"],
          suspended: false,
          isAdmin: true,
        },
        {
          email: "juniper@example.test",
          name: "Juniper Vale",
          aliases: [],
          suspended: true,
          isAdmin: false,
        },
      ],
      groups: [
        {
          email: "studio@example.test",
          name: "Studio",
          description: null,
          aliases: [],
          members: ["ada@example.test", "*"],
          sharedInbox: true,
          posting: "workspace",
        },
      ],
    });
  });

  it("asks for an administrator to act as", async () => {
    await expect(
      googleAccessToken({
        credentials: {
          type: "service_account",
          client_email: "x",
          private_key: "",
        },
        groupSettings: false,
        fetch,
        openBrowser: () => {},
        log: () => {},
      })
    ).rejects.toThrow("--admin");
  });
});
