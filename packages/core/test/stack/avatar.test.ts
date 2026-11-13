import { beforeAll, describe, expect, it } from "bun:test";

import { z } from "zod";

import { required } from "../../shared/invariant.ts";
import { env, useFreshWorkspace, worker } from "../../testing/client.ts";

useFreshWorkspace();

const origin = "http://example.test";
let cookie = "";

// A 1x1 PNG with a bad checksum, which browsers forgive and resizing doesn't.
const brokenPng = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02,
  0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44,
  0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xff, 0xff, 0x3f, 0x00, 0x05, 0xfe, 0x02,
  0xfe, 0xa3, 0x5f, 0x45, 0x40, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82,
]);

// A valid 4x4 PNG.
const squarePng = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x04, 0x08, 0x02,
  0x00, 0x00, 0x00, 0x26, 0x93, 0x09, 0x29, 0x00, 0x00, 0x00, 0x10, 0x49, 0x44,
  0x41, 0x54, 0x78, 0x9c, 0x63, 0x30, 0x8d, 0xb9, 0x02, 0x47, 0x0c, 0xc4, 0x71,
  0x00, 0x3a, 0x82, 0x16, 0x51, 0xa8, 0x69, 0x64, 0x2f, 0x00, 0x00, 0x00, 0x00,
  0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

/** The response's text, once it is a success. */
async function expectOk(response: Response) {
  const text = await response.text();
  expect(response.status, text).toBeLessThan(400);

  return text;
}

/** A successful response's JSON body, parsed by `schema`. */
async function body<T>(response: Response, schema: z.ZodType<T>) {
  return schema.parse(JSON.parse(await expectOk(response)));
}

const uploaded = z.object({ avatarId: z.string() });

const signedIn = z.object({
  user: z.object({ id: z.string(), avatarId: z.string().nullable() }),
});

/** The session cookie a sign-in sets, as a Cookie header sends it back. */
const sessionCookie = (response: Response) =>
  required(
    response.headers.get("set-cookie")?.split(";", 1)[0],
    "signing in sets a session cookie"
  );

function upload(
  bytes: Uint8Array<ArrayBuffer>,
  name = "avatar.png",
  type = "image/png"
) {
  const form = new FormData();
  form.set("file", new File([bytes], name, { type }));

  return worker.fetch(
    new Request(`${origin}/api/auth/avatar`, {
      method: "POST",
      headers: { cookie },
      body: form,
    })
  );
}

async function currentUser() {
  const response = await worker.fetch(
    new Request(`${origin}/api/bootstrap`, { headers: { cookie } })
  );

  return (await body(response, signedIn)).user;
}

/** The avatar's URL as the browser builds it (shared/avatar.ts). */
const avatarUrl = (userId: string, avatarId: string, size: number | string) =>
  `${origin}/api/avatars/${userId}/${avatarId}?size=${size}`;

/** A WebP's width: the VP8X canvas (24 bits at byte 24, minus one) or a lossy VP8 frame. */
function webpWidth(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const chunk = new TextDecoder().decode(bytes.subarray(12, 16));

  if (chunk === "VP8X") {
    return 1 + (view.getUint16(24, true) | (view.getUint8(26) << 16));
  }

  if (chunk === "VP8 ") return view.getUint16(26, true) & 0x3f_ff;

  // VP8L: 14 bits after the signature byte.
  return 1 + (view.getUint16(21, true) & 0x3f_ff);
}

beforeAll(async () => {
  const bootstrap = await worker.fetch(
    new Request(`${origin}/api/auth/mock/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Avatar Admin",
        email: "avatar-admin@example.test",
      }),
    })
  );

  cookie = sessionCookie(bootstrap);
  await expectOk(bootstrap);
});

describe("avatars", () => {
  it("are served by the Worker as square WebP at the allowed sizes, cached for good", async () => {
    const { avatarId } = await body(await upload(squarePng), uploaded);

    expect(avatarId).toMatch(/^[0-9a-f]{32}$/u);
    const user = await currentUser();
    expect(user.avatarId).toBe(avatarId);
    // The original, in core's media bucket, with the type its bytes show.
    const stored = await env.MEDIA.get(`avatars/${user.id}/${avatarId}`);
    expect(stored?.httpMetadata?.contentType).toBe("image/png");
    expect(await stored?.bytes()).toEqual(squarePng);

    const stackUrl = required(process.env.STACK_URL, "the stack is deployed");

    await Promise.all(
      [128, 256].map(async (size) => {
        // No session: apps show it from their own sites.
        const image = await fetch(
          avatarUrl(user.id, avatarId, size).replace(origin, stackUrl)
        );

        expect(image.status).toBe(200);
        expect(image.headers.get("content-type")).toBe("image/webp");
        expect(image.headers.get("cache-control")).toBe(
          "public, max-age=31536000, immutable"
        );
        expect(image.headers.get("cross-origin-resource-policy")).toBe(
          "cross-origin"
        );
        expect(image.headers.get("x-content-type-options")).toBe("nosniff");
        expect(webpWidth(new Uint8Array(await image.arrayBuffer()))).toBe(size);
      })
    );

    await Promise.all(
      ["64", "100", ""].map(async (size) => {
        expect(
          (await worker.fetch(avatarUrl(user.id, avatarId, size))).status,
          size
        ).toBe(400);
      })
    );

    expect(
      (await worker.fetch(`${origin}/api/avatars/${user.id}/${avatarId}`))
        .status
    ).toBe(400);
    expect(
      (
        await worker.fetch(
          `${origin}/api/avatars/${user.id}/not-an-id?size=128`
        )
      ).status
    ).toBe(404);
  });

  it("serve the original, uncached, when Images can't resize it", async () => {
    const { avatarId } = await body(await upload(brokenPng), uploaded);

    const image = await worker.fetch(
      avatarUrl((await currentUser()).id, avatarId, 128)
    );

    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("cache-control")).toBe("no-cache");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(brokenPng);
  });

  it("take only images, by their bytes", async () => {
    expect(
      (
        await upload(
          new TextEncoder().encode("<svg/>"),
          "a.svg",
          "image/svg+xml"
        )
      ).status
    ).toBe(400);
    expect(
      (await upload(new TextEncoder().encode("<html></html>"), "a.png")).status
    ).toBe(400);
  });

  it("get a new URL on every upload, and a replaced or removed one is gone", async () => {
    const userId = (await currentUser()).id;

    const first = (await body(await upload(squarePng), uploaded)).avatarId;

    const second = (await body(await upload(squarePng), uploaded)).avatarId;

    expect(second).not.toBe(first);
    expect(await env.MEDIA.head(`avatars/${userId}/${first}`)).toBeNull();
    const replaced = await worker.fetch(avatarUrl(userId, first, 128));
    expect(replaced.status).toBe(404);
    expect(replaced.headers.get("cache-control")).toBe("no-store");
    expect((await worker.fetch(avatarUrl(userId, second, 128))).status).toBe(
      200
    );

    await expectOk(
      await worker.fetch(
        new Request(`${origin}/api/auth/avatar`, {
          method: "DELETE",
          headers: { cookie },
        })
      )
    );
    expect((await currentUser()).avatarId).toBeNull();

    const stored = await env.DB.prepare(
      "SELECT avatar_id AS avatarId FROM users WHERE id = ?"
    )
      .bind(userId)
      .first<{ avatarId: string | null }>();

    expect(stored?.avatarId).toBeNull();
    expect(
      await env.MEDIA.list({ prefix: `avatars/${userId}/` })
    ).toMatchObject({ objects: [] });
    expect((await worker.fetch(avatarUrl(userId, second, 128))).status).toBe(
      404
    );
  });
});
