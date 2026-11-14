import { internet } from "@open-workspace/core/testing";
import { z } from "zod";

/**
 * Email Routing's destination addresses API, answered in the test process
 * (worker/mail/email-routing.ts calls it). setup.ts binds a placeholder
 * account and token, so the Worker's requests come here like any other
 * outgoing request. Destinations start unconfirmed; `confirm` follows the
 * link Cloudflare would have emailed. Handlers go with the test that added
 * them, so call this in each test.
 */
export function fakeEmailRouting() {
  const verified = new Map<string, boolean>();

  internet.handle(async (request) => {
    const { hostname, pathname } = request.target;

    if (
      hostname !== "api.cloudflare.com" ||
      !pathname.endsWith("/email/routing/addresses")
    ) {
      return undefined;
    }

    if (request.method === "POST") {
      const { email } = z
        .object({ email: z.string() })
        .parse(await request.json());

      verified.set(email, false);

      return Response.json({
        success: true,
        result: { email, verified: null },
      });
    }

    return Response.json({
      success: true,
      result: [...verified].map(([email, confirmed]) => ({
        email,
        verified: confirmed ? "2026-11-01T00:00:00Z" : null,
      })),
    });
  });

  return {
    /** Every destination the Worker added, and whether it's confirmed. */
    verified,
    confirm: (email: string) => void verified.set(email, true),
  };
}
