import { beforeAll, describe, expect, it } from "bun:test";

import { z } from "zod";

import { required } from "../../shared/invariant.ts";
import { corePermissions } from "../../shared/workspace.ts";
import { env, useFreshWorkspace, worker } from "../../testing/client.ts";

useFreshWorkspace();

const origin = "http://example.test";
let adminCookie = "";
let secondAdminCookie = "";
let memberCookie = "";

// A 1x1 PNG.
const png = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02,
  0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44,
  0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xff, 0xff, 0x3f, 0x00, 0x05, 0xfe, 0x02,
  0xfe, 0xa3, 0x5f, 0x45, 0x40, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82,
]);

// A valid 4x4 PNG (the 1x1 one above has a bad checksum, which browsers forgive and resizing doesn't).
const squarePng = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x04, 0x08, 0x02,
  0x00, 0x00, 0x00, 0x26, 0x93, 0x09, 0x29, 0x00, 0x00, 0x00, 0x10, 0x49, 0x44,
  0x41, 0x54, 0x78, 0x9c, 0x63, 0x30, 0x8d, 0xb9, 0x02, 0x47, 0x0c, 0xc4, 0x71,
  0x00, 0x3a, 0x82, 0x16, 0x51, 0xa8, 0x69, 0x64, 0x2f, 0x00, 0x00, 0x00, 0x00,
  0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

function upload(cookie: string, file: File) {
  const form = new FormData();
  form.set("file", file);

  return worker.fetch(
    new Request(`${origin}/api/admin/branding/logo`, {
      method: "POST",
      headers: { cookie, origin },
      body: form,
    })
  );
}

function removeLogo(cookie: string) {
  return worker.fetch(
    new Request(`${origin}/api/admin/branding/logo`, {
      method: "DELETE",
      headers: { cookie, origin },
    })
  );
}

const uploadedLogo = z.object({ logoUrl: z.string() });

const signedOutState = z.object({
  workspaceLogoUrl: z.string().nullable(),
  workspaceName: z.string().nullable(),
});

/** The session cookie a sign-in sets, as a Cookie header sends it back. */
const sessionCookie = (response: Response) =>
  required(
    response.headers.get("set-cookie")?.split(";", 1)[0],
    "signing in sets a session cookie"
  );

/** What the sign-in screen gets: no session cookie. */
async function signedOutBootstrap() {
  const response = await worker.fetch(`${origin}/api/bootstrap`);
  expect(response.status).toBe(200);

  return signedOutState.parse(await response.json());
}

async function signedOutLogoUrl() {
  return (await signedOutBootstrap()).workspaceLogoUrl;
}

function setName(cookie: string, name: string) {
  return worker.fetch(
    new Request(`${origin}/api/admin/branding/name`, {
      method: "PUT",
      headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({ name }),
    })
  );
}

async function signIn(userId: string) {
  const response = await worker.fetch(
    new Request(`${origin}/api/auth/mock/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId }),
    })
  );

  expect(response.status).toBe(200);
  await response.json();

  return sessionCookie(response);
}

beforeAll(async () => {
  const bootstrap = await worker.fetch(
    new Request(`${origin}/api/auth/mock/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Logo Admin",
        email: "logo-admin@example.test",
      }),
    })
  );

  expect(bootstrap.status).toBe(200);
  adminCookie = sessionCookie(bootstrap);
  // A member who may manage everything a member can be given.
  await env.DB.prepare(
    "INSERT INTO users (id, name, role, status, permissions) VALUES (?, ?, 'member', 'active', ?)"
  )
    .bind(
      "usr_logo_member",
      "Logo Member",
      JSON.stringify(corePermissions.map((permission) => permission.id))
    )
    .run();
  memberCookie = await signIn("usr_logo_member");
  // Logo changes are limited per person; the limit test uses up the first administrator's.
  await env.DB.prepare(
    "INSERT INTO users (id, name, role, status) VALUES ('usr_logo_admin_2', 'Second Logo Admin', 'admin', 'active')"
  ).run();
  secondAdminCookie = await signIn("usr_logo_admin_2");
});

describe("workspace logo", () => {
  it("starts without one", async () => {
    expect(await signedOutLogoUrl()).toBeNull();
  });

  it("is managed by administrators only", async () => {
    const uploaded = await upload(
      memberCookie,
      new File([png], "logo.png", { type: "image/png" })
    );

    expect(uploaded.status).toBe(403);
    expect((await removeLogo(memberCookie)).status).toBe(403);
    expect(await signedOutLogoUrl()).toBeNull();
  });

  it("takes only PNG, JPEG and WebP images up to 1 MB", async () => {
    const svg = await upload(
      adminCookie,
      new File(
        [
          '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        ],
        "logo.svg",
        { type: "image/svg+xml" }
      )
    );

    expect(svg.status).toBe(400);

    // The bytes decide, not the declared type.
    const disguised = await upload(
      adminCookie,
      new File(["<html></html>"], "logo.png", { type: "image/png" })
    );

    expect(disguised.status).toBe(400);
    const large = new Uint8Array(1024 * 1024 + 1);
    large.set(png);

    const tooLarge = await upload(
      adminCookie,
      new File([large], "logo.png", { type: "image/png" })
    );

    expect(tooLarge.status).toBe(400);
    expect(await signedOutLogoUrl()).toBeNull();
  });

  it("is uploaded, served to signed-out visitors, replaced and removed", async () => {
    const uploaded = await upload(
      adminCookie,
      new File([png], "logo.png", { type: "image/png" })
    );

    expect(uploaded.status).toBe(200);
    const { logoUrl } = uploadedLogo.parse(await uploaded.json());
    expect(logoUrl).toMatch(/^\/api\/workspace-logo\/[0-9a-f]{32}$/u);
    const logoKey = (url: string) => `workspace/logo/${url.split("/").at(-1)}`;
    // The original, in core's media bucket.
    expect(
      (await env.MEDIA.head(logoKey(logoUrl)))?.httpMetadata?.contentType
    ).toBe("image/png");
    expect(await signedOutLogoUrl()).toBe(logoUrl);

    const image = await worker.fetch(`${origin}${logoUrl}`);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("cache-control")).toContain("immutable");
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);

    // A new upload is a new image at a new URL, and the old one is deleted.
    const replaced = await upload(
      adminCookie,
      new File([png], "logo.png", { type: "image/png" })
    );

    const { logoUrl: replacedUrl } = uploadedLogo.parse(await replaced.json());

    expect(replacedUrl).not.toBe(logoUrl);
    expect(await signedOutLogoUrl()).toBe(replacedUrl);
    expect((await worker.fetch(`${origin}${logoUrl}`)).status).toBe(404);
    expect(await env.MEDIA.head(logoKey(logoUrl))).toBeNull();

    // An icon Images can't make from it (this PNG's checksum is bad) is the
    // original, not kept, so the next request tries again.
    const unresized = await worker.fetch(`${origin}${replacedUrl}?size=192`);
    expect(unresized.status).toBe(200);
    expect(unresized.headers.get("content-type")).toBe("image/png");
    expect(unresized.headers.get("cache-control")).toBe("no-cache");
    expect(new Uint8Array(await unresized.arrayBuffer())).toEqual(png);

    expect((await removeLogo(adminCookie)).status).toBe(200);
    expect(await signedOutLogoUrl()).toBeNull();
    expect(await env.MEDIA.list({ prefix: "workspace/logo/" })).toMatchObject({
      objects: [],
    });
    const gone = await worker.fetch(`${origin}${replacedUrl}`);
    expect(gone.status).toBe(404);
    expect(gone.headers.get("cache-control")).toBe("no-store");
  });

  it("limits how often it changes", async () => {
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 12; attempt += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the per-person limit counts changes in order until it refuses one
      statuses.push((await removeLogo(adminCookie)).status);
    }

    expect(statuses).toContain(429);
  });
});

describe("workspace name", () => {
  it("starts unset", async () => {
    expect((await signedOutBootstrap()).workspaceName).toBeNull();
  });

  it("is set by administrators only, trimmed, and cleared when empty", async () => {
    expect((await setName(memberCookie, "Acme")).status).toBe(403);
    expect((await signedOutBootstrap()).workspaceName).toBeNull();

    const saved = await setName(adminCookie, "  Acme Studio  ");
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ ok: true, name: "Acme Studio" });
    expect((await signedOutBootstrap()).workspaceName).toBe("Acme Studio");

    expect((await setName(adminCookie, "x".repeat(61))).status).toBe(400);
    expect((await setName(adminCookie, "Line\nbreak")).status).toBe(400);
    expect((await signedOutBootstrap()).workspaceName).toBe("Acme Studio");

    expect((await setName(adminCookie, "")).status).toBe(200);
    expect((await signedOutBootstrap()).workspaceName).toBeNull();
  });
});

describe("icons and the web app manifest", () => {
  const manifestSchema = z.object({
    name: z.string(),
    short_name: z.string(),
    icons: z.array(
      z.object({ src: z.string(), sizes: z.string(), purpose: z.string() })
    ),
  });

  async function manifest() {
    const response = await worker.fetch(`${origin}/manifest.webmanifest`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(
      "application/manifest+json"
    );
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");

    return manifestSchema.parse(await response.json());
  }

  async function iconRedirect(size: number) {
    const response = await worker.fetch(
      `${origin}/api/workspace-logo/icon/${size}`,
      { redirect: "manual" }
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("cache-control")).toBe("no-cache");

    return response.headers.get("location");
  }

  it("use the OpenWorkspace icons and name by default", async () => {
    expect(await iconRedirect(64)).toBe("/icons/app-icon.svg");
    expect(await iconRedirect(192)).toBe("/icons/app-icon-192.png");
    const app = await manifest();
    expect(app.name).toBe("OpenWorkspace");
    expect(app.icons.map((icon) => `${icon.purpose} ${icon.src}`)).toEqual([
      "any /icons/app-icon-192.png",
      "any /icons/app-icon-512.png",
      "maskable /icons/app-icon-maskable-192.png",
      "maskable /icons/app-icon-maskable-512.png",
    ]);

    const unknown = await worker.fetch(
      `${origin}/api/workspace-logo/icon/100`,
      { redirect: "manual" }
    );

    expect(unknown.status).toBe(404);
  });

  it("follow the logo and the name, at the logo's URLs", async () => {
    await setName(secondAdminCookie, "Acme Studio");

    const uploaded = await upload(
      secondAdminCookie,
      new File([squarePng], "logo.png", { type: "image/png" })
    );

    const { logoUrl } = uploadedLogo.parse(await uploaded.json());

    expect(await iconRedirect(192)).toBe(`${logoUrl}?size=192`);
    const app = await manifest();
    expect(app.name).toBe("Acme Studio");
    expect(app.short_name).toBe("Acme Studio");
    expect(app.icons.map((icon) => `${icon.purpose} ${icon.src}`)).toEqual([
      `any ${logoUrl}?size=192`,
      `any ${logoUrl}?size=512`,
      // Launchers crop maskable icons; the logo has no safe zone, so these stay.
      "maskable /icons/app-icon-maskable-192.png",
      "maskable /icons/app-icon-maskable-512.png",
    ]);

    const icon = await worker.fetch(`${origin}${logoUrl}?size=192`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/png");
    expect(icon.headers.get("cache-control")).toContain("immutable");
    expect(icon.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = new Uint8Array(await icon.arrayBuffer());
    // A PNG 192 pixels wide (IHDR width, big-endian at byte 16).
    expect(new DataView(bytes.buffer).getUint32(16)).toBe(192);
    expect((await worker.fetch(`${origin}${logoUrl}?size=100`)).status).toBe(
      400
    );
    expect(
      (await worker.fetch(`${origin}/api/workspace-logo/not-an-id`)).status
    ).toBe(404);

    await removeLogo(secondAdminCookie);
    await setName(secondAdminCookie, "");
    expect(await iconRedirect(192)).toBe("/icons/app-icon-192.png");
    expect((await manifest()).name).toBe("OpenWorkspace");
  });
});
