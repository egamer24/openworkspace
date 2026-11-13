import { afterEach, expect, it } from "bun:test";

import { z } from "zod";

import { required } from "../../shared/invariant.ts";
import type { DeclaredWebhook } from "../../shared/webhook-declarations.ts";
import { env, hooks, useFreshWorkspace, worker } from "../../testing/client.ts";

useFreshWorkspace();

const origin = "http://example.test";

const webhookList = z.object({
  webhooks: z.array(
    z.looseObject({ id: z.string(), name: z.string(), managedBy: z.string() })
  ),
});

const hook: DeclaredWebhook = {
  id: `whk_${"c".repeat(32)}`,
  name: "Billing",
  url: "https://billing.example.net/hooks/openworkspace",
  events: ["user.joined"],
  enabled: true,
  secret: `whsec_${btoa("0123456789abcdef0123456789abcdef")}`,
};

/** Redeclares the Worker's webhooks, as a deploy with other declarations would. */
function declare(webhooks: DeclaredWebhook[]) {
  return hooks.call("sso.declareWebhooks", JSON.stringify(webhooks));
}

afterEach(async () => {
  await declare([]);
});

it("keeps declared webhook endpoints in D1 and out of the admin API's hands", async () => {
  await declare([hook]);

  const bootstrap = await worker.fetch(
    new Request(`${origin}/api/auth/mock/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Wes Hook", email: "wes@example.test" }),
    })
  );

  const cookie = required(
    bootstrap.headers.get("set-cookie")?.split(";", 1)[0],
    "sign-up sets a session cookie"
  );

  const listed = await worker.fetch(
    new Request(`${origin}/api/admin/webhooks`, { headers: { cookie } })
  );

  const listing = await listed.text();
  const body = webhookList.parse(JSON.parse(listing));

  expect(body.webhooks).toEqual([
    expect.objectContaining({
      id: hook.id,
      name: "Billing",
      managedBy: "deployment",
    }),
  ]);
  expect(listing).not.toContain(hook.secret);
  expect(
    await env.DB.prepare(
      "SELECT signing_secret FROM webhook_endpoints WHERE id = ?"
    )
      .bind(hook.id)
      .first("signing_secret")
  ).toBe(hook.secret);

  // Each is refused, so none changes what the others see.
  await Promise.all(
    (
      [
        ["PUT", `/api/admin/webhooks/${hook.id}`],
        ["DELETE", `/api/admin/webhooks/${hook.id}`],
        ["POST", `/api/admin/webhooks/${hook.id}/rotate-secret`],
      ] as const
    ).map(async ([method, path]) => {
      const response = await worker.fetch(
        new Request(`${origin}${path}`, {
          method,
          headers: { cookie, origin, "content-type": "application/json" },
          body:
            method === "DELETE"
              ? undefined
              : JSON.stringify({
                  name: "x",
                  url: hook.url,
                  events: hook.events,
                  enabled: true,
                }),
        })
      );

      expect(response.status, `${method} ${path}`).toBe(409);
    })
  );

  // Sending a test event is still allowed.
  const test = await worker.fetch(
    new Request(`${origin}/api/admin/webhooks/${hook.id}/test`, {
      method: "POST",
      headers: { cookie, origin },
    })
  );

  expect(test.status).toBe(202);

  await declare([]);
  await hooks.call("sso.syncDeclaredWebhooks");
  expect(
    await env.DB.prepare("SELECT count(*) AS n FROM webhook_endpoints").first(
      "n"
    )
  ).toBe(0);
});
