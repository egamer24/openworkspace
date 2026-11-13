import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { z } from "zod";

import { required } from "../../shared/invariant.ts";
import { hooks, useFreshWorkspace, worker } from "../../testing/client.ts";

useFreshWorkspace();

const origin = "http://example.test";
let adminCookie = "";

/** The administration requests this test sends: an invitation, a team, a team address. */
type AdminRequest =
  | { name: string; email: string }
  | {
      name: string;
      slug: string;
      description: null;
      everyone: boolean;
      members: [];
    }
  | {
      address: string;
      displayName: string;
      ownerUserId: null;
      teamId: string;
      delivery: "inbox";
      listPosting: "workspace";
    };

function post(path: string, json: AdminRequest) {
  return worker.fetch(
    new Request(`${origin}${path}`, {
      method: "POST",
      headers: {
        cookie: adminCookie,
        origin,
        "content-type": "application/json",
      },
      body: JSON.stringify(json),
    })
  );
}

beforeAll(async () => {
  const bootstrap = await worker.fetch(
    new Request(`${origin}/api/auth/mock/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "admin@example.test" }),
    })
  );

  expect(bootstrap.status).toBe(200);
  adminCookie = required(
    bootstrap.headers.get("set-cookie")?.split(";", 1)[0],
    "signing in sets a session cookie"
  );
  await hooks.call("modules.claimAddresses", ["billing@example.test"]);
});

afterAll(() => hooks.call("modules.claimAddresses", null));

describe("an address a module already routes", () => {
  it("can't become a person's address", async () => {
    const response = await post("/api/admin/invitations", {
      name: "Billing",
      email: "Billing@Example.test",
    });

    expect(response.status).toBe(409);
    await response.body?.cancel();
  });

  it("can't become a team address", async () => {
    const team = await post("/api/admin/teams", {
      name: "Finance",
      slug: "finance",
      description: null,
      everyone: false,
      members: [],
    });

    expect(team.status).toBe(201);

    const { teamId } = z
      .object({ teamId: z.string() })
      .parse(await team.json());

    const claimed = await post("/api/admin/mailboxes", {
      address: "billing@example.test",
      displayName: "Billing",
      ownerUserId: null,
      teamId,
      delivery: "inbox",
      listPosting: "workspace",
    });

    expect(claimed.status).toBe(409);
    await claimed.body?.cancel();

    const free = await post("/api/admin/mailboxes", {
      address: "finance@example.test",
      displayName: "Finance",
      ownerUserId: null,
      teamId,
      delivery: "inbox",
      listPosting: "workspace",
    });

    expect(free.status).toBe(201);
    await free.body?.cancel();
  });
});
