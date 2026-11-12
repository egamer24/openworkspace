import { required } from "@open-workspace/core/shared";
import { expect, request, test } from "playwright/test";
import type { APIRequestContext, Page } from "playwright/test";
import { z } from "zod";

const MCP_PROTOCOL_VERSION = "2026-07-28";
const REDIRECT_URI = "http://127.0.0.1:33418/callback";

async function signIn(page: Page) {
  await page.goto("/");
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/auth/mock/login") && response.ok()
    ),
    page.getByRole("button", { name: "Open seeded local demo" }).click(),
  ]);
}

function base64Url(bytes: ArrayBuffer | Uint8Array) {
  return Buffer.from(
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  ).toString("base64url");
}

/**
 * Signs an MCP client in as the browser's person, the way a real client
 * does: register, authorize with PKCE and the MCP resource, approve the
 * consent screen, exchange the code.
 */
async function mcpToken(api: APIRequestContext, origin: string, scope: string) {
  const registered = await api.post("/oauth/register", {
    data: { client_name: "Notes test agent", redirect_uris: [REDIRECT_URI] },
  });

  expect(registered.status()).toBe(201);

  const { client_id: clientId } = z
    .object({ client_id: z.string() })
    .parse(await registered.json());

  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));

  const challenge = base64Url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  );

  const authorize = new URL("/oauth/authorize", origin);

  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope,
    resource: `${origin}/mcp`,
    state: "notes",
  })) {
    authorize.searchParams.set(key, value);
  }

  const authorized = await api.get(authorize.toString(), {
    maxRedirects: 0,
  });

  const location = authorized.headers().location ?? "";
  const consent = location.match(/\/oidc\/consent\/([^/?#]+)/u)?.[1];
  expect(consent, location).toBeTruthy();

  const approved = await api.post(`/api/oidc/consent/${consent}`, {
    headers: { origin },
    data: { approved: true },
  });

  expect(approved.status()).toBe(200);

  const { redirectTo } = z
    .object({ redirectTo: z.string() })
    .parse(await approved.json());

  const code = required(
    new URL(redirectTo).searchParams.get("code"),
    `a code in ${redirectTo}`
  );

  const token = await api.post("/oauth/token", {
    form: {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      client_id: clientId,
      resource: `${origin}/mcp`,
    },
  });

  expect(token.status()).toBe(200);

  return z.object({ access_token: z.string() }).parse(await token.json())
    .access_token;
}

/** A tools/call's tool and its arguments; tools/list takes none. */
type McpParams = { name?: string; arguments?: Record<string, string> };

/** The MCP transport headers; mcp-name names the tool of a tools/call. */
type McpHeaders = {
  accept: string;
  authorization: string;
  "mcp-method": string;
  "mcp-protocol-version": string;
  "mcp-name"?: string;
};

/** An MCP request's result, parsed with `schema`. */
async function mcp<Schema extends z.ZodType>(
  api: APIRequestContext,
  token: string,
  method: string,
  schema: Schema,
  params: McpParams = {}
): Promise<z.output<Schema>> {
  const headers: McpHeaders = {
    accept: "application/json",
    authorization: `Bearer ${token}`,
    "mcp-method": method,
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
  };

  if (params.name) headers["mcp-name"] = params.name;

  const response = await api.post("/mcp", {
    headers,
    data: {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientInfo": {
            name: "notes-e2e",
            version: "1.0.0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    },
  });

  expect(response.status(), await response.text()).toBe(200);

  const { result } = z
    .object({ result: z.json() })
    .parse(await response.json());

  return schema.parse(result);
}

const toolsSchema = z.object({
  tools: z.array(z.object({ name: z.string() })),
});

const noteSchema = z.object({ title: z.string() });

test("Notes is an app in the switcher, and writes notes", async ({ page }) => {
  await signIn(page);
  await page.goto("/notes");
  await expect(page.getByRole("form", { name: "New note" })).toBeVisible();

  await page.getByRole("button", { name: "Switch app, now Notes" }).click();
  await expect(page.getByRole("menuitem", { name: "Notes" })).toBeVisible();
  await page.keyboard.press("Escape");

  const title = `Groceries ${test.info().project.name}`;
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByLabel("Note", { exact: true }).fill("Oat milk\nCoffee beans");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(
    page.getByRole("listitem").filter({ hasText: title })
  ).toContainText("Coffee beans");

  // The same note over the module's API, with the browser's session.
  const listed = await page.request.get("/api/notes");
  expect(listed.status()).toBe(200);
  expect(
    z
      .object({ notes: z.array(noteSchema) })
      .parse(await listed.json())
      .notes.map((note) => note.title)
  ).toContain(title);
});

test("Settings → Notes orders the list, and Administration → Notes lists everyone's", async ({
  page,
}) => {
  await signIn(page);

  // One after the other: the list's "newest" order depends on which came first.
  expect(
    (
      await page.request.post("/api/notes", { data: { title: "Banana bread" } })
    ).status()
  ).toBe(201);
  expect(
    (
      await page.request.post("/api/notes", { data: { title: "Apple pie" } })
    ).status()
  ).toBe(201);

  // Start from the default order, whatever an earlier project chose.
  expect(
    (
      await page.request.put("/api/notes/preferences", {
        data: { order: "newest" },
      })
    ).status()
  ).toBe(200);
  await page.goto("/settings/notes");
  await page.getByRole("radio", { name: /By title/u }).click();
  await expect(page.getByText("Notes are listed by title")).toBeVisible();
  await page.goto("/notes");
  const titles = page.getByRole("listitem").locator("p.font-semibold");
  await expect(titles.first()).toHaveText("Apple pie");

  await page.goto("/admin/notes");
  await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible();
  const row = page.getByRole("listitem").filter({ hasText: "Banana bread" });
  await expect(row).toContainText("Sam Brooks");
  await row.getByRole("button", { name: "Delete Banana bread" }).click();
  await page.getByRole("button", { name: "Delete note" }).click();
  await expect(page.getByText("Note deleted")).toBeVisible();
  await expect(
    page.getByRole("listitem").filter({ hasText: "Banana bread" })
  ).toHaveCount(0);
});

test("the webhook editor offers the module's event", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "Administration forms are covered once"
  );
  await signIn(page);
  await page.goto("/admin/webhooks");
  await page.getByRole("button", { name: "Add endpoint" }).click();
  await expect(
    page.getByRole("group", { name: "Events" }).getByText("Note created")
  ).toBeVisible();
});

test("an MCP client lists and writes notes with the scopes it was granted", async ({
  page,
  baseURL,
}) => {
  await signIn(page);
  const { origin } = new URL(required(baseURL, "the project's baseURL"));

  const writer = await mcpToken(page.request, origin, "notes.read notes.write");

  const tools = await mcp(page.request, writer, "tools/list", toolsSchema);

  expect(tools.tools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining(["list_notes", "create_note"])
  );

  const created = await mcp(
    page.request,
    writer,
    "tools/call",
    z.object({ structuredContent: z.object({ note: noteSchema }) }),
    {
      name: "create_note",
      arguments: {
        title: `From an agent ${test.info().project.name}`,
        body: "Written over MCP",
      },
    }
  );

  expect(created.structuredContent.note.title).toBe(
    `From an agent ${test.info().project.name}`
  );

  const listed = await mcp(
    page.request,
    writer,
    "tools/call",
    z.object({
      structuredContent: z.object({ notes: z.array(noteSchema) }),
    }),
    { name: "list_notes", arguments: {} }
  );

  expect(listed.structuredContent.notes.map((note) => note.title)).toContain(
    `From an agent ${test.info().project.name}`
  );

  // Read-only: the write tool is not there, and the API refuses the write.
  const reader = await mcpToken(page.request, origin, "notes.read");

  const readerTools = await mcp(
    page.request,
    reader,
    "tools/list",
    toolsSchema
  );

  expect(readerTools.tools.map((tool) => tool.name)).toContain("list_notes");
  expect(readerTools.tools.map((tool) => tool.name)).not.toContain(
    "create_note"
  );
  const app = await request.newContext({ baseURL: origin });

  const read = await app.get("/api/notes", {
    headers: { authorization: `Bearer ${reader}` },
  });

  expect(read.status()).toBe(200);

  const refused = await app.post("/api/notes", {
    headers: { authorization: `Bearer ${reader}` },
    data: { title: "Not allowed" },
  });

  expect(refused.status()).toBe(403);
  await app.dispose();
});
