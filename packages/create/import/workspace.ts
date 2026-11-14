import { z } from "zod";

import type { Fetch, TokenSource } from "./oauth.ts";
import { importTargetSchema } from "./protocol.ts";
import type { ImportItem } from "./protocol.ts";

export class WorkspaceError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export type ImportResult =
  | {
      status: "imported";
      id: string;
      conversationId: string;
      folderSkipped: string | null;
    }
  | { status: "duplicate"; id: string; conversationId: string };

/** The workspace's HTTP API, signed in with an OAuth token. */
export class Workspace {
  readonly origin: string;

  constructor(
    workspace: string,
    private readonly auth: TokenSource,
    private readonly fetchImpl: Fetch = (input, init) => fetch(input, init)
  ) {
    this.origin = new URL(workspace).origin;
  }

  /** A request with the token; a refused token is refreshed once. */
  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const send = (token: string) => {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${token}`);

      return this.fetchImpl(`${this.origin}${path}`, { ...init, headers });
    };

    const response = await send(await this.auth.token());

    if (response.status !== 401) return response;
    await response.body?.cancel();

    return send(await this.auth.refresh());
  }

  /** The API's JSON answer parsed with `schema`, or a WorkspaceError with its message. */
  async json<Schema extends z.ZodType>(
    path: string,
    schema: Schema,
    init: JsonRequest = {}
  ): Promise<z.output<Schema>> {
    return parse(await this.send(path, init), schema);
  }

  /** A request whose answer only needs to be a success; else a WorkspaceError. */
  async call(path: string, init: JsonRequest = {}): Promise<void> {
    await parse(await this.send(path, init), z.unknown());
  }

  private send(path: string, init: JsonRequest) {
    if (init.raw) {
      return this.request(path, {
        method: init.method ?? "POST",
        headers: { "content-type": "application/octet-stream" },
        body: init.raw,
      });
    }

    return this.request(path, {
      method: init.method ?? "GET",
      headers:
        init.body === undefined ? {} : { "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  }

  importTargets() {
    return this.json(
      "/api/mail/import/mailboxes",
      z.object({ mailboxes: z.array(importTargetSchema) })
    ).then((body) => body.mailboxes);
  }

  /** A mailbox this sign-in may import into, by id or address. */
  async importTarget(idOrAddress: string) {
    const wanted = idOrAddress.trim().toLowerCase();
    const targets = await this.importTargets();

    const target = targets.find(
      (item) =>
        item.id.toLowerCase() === wanted ||
        item.address.toLowerCase() === wanted
    );

    if (!target) {
      throw new Error(
        `You may not import into ${idOrAddress} (or it does not exist). You may import into: ${
          targets.map((item) => item.address).join(", ") || "no mailbox"
        }`
      );
    }

    return target;
  }

  async importMessage(
    mailboxId: string,
    item: ImportItem
  ): Promise<ImportResult> {
    const query = new URLSearchParams({
      sourceId: item.sourceId,
      placement: item.placement,
    });

    if (item.folder) query.set("folder", item.folder);

    if (item.seen) query.set("seen", "1");

    if (item.thread) query.set("thread", item.thread);

    if (item.receivedAt !== undefined) {
      query.set("receivedAt", String(item.receivedAt));
    }

    if (item.direction) query.set("direction", item.direction);

    const response = await this.request(
      `/api/mail/import/mailboxes/${encodeURIComponent(mailboxId)}/messages?${query}`,
      {
        method: "POST",
        headers: { "content-type": "message/rfc822" },
        body: item.raw,
      }
    );

    const body = await parse(response, importResponseSchema);

    return body.duplicate
      ? {
          status: "duplicate",
          id: body.id,
          conversationId: body.conversationId,
        }
      : {
          status: "imported",
          id: body.id,
          conversationId: body.conversationId,
          folderSkipped: body.folderSkipped ?? null,
        };
  }

  finishImport(mailboxId: string) {
    return this.json(
      `/api/mail/import/mailboxes/${encodeURIComponent(mailboxId)}/finish`,
      z.object({ version: z.number() }),
      { method: "POST" }
    );
  }
}

type JsonRequest = {
  method?: string;
  body?: unknown;
  /** Bytes sent as they are, instead of a JSON `body`. */
  raw?: Uint8Array<ArrayBuffer>;
};

const importResponseSchema = z.object({
  duplicate: z.boolean(),
  id: z.string(),
  conversationId: z.string(),
  folderSkipped: z.string().nullish(),
});

/** The API's error envelope; anything else (a proxy's error page) leaves it empty. */
const errorSchema = z.object({
  error: z
    .object({ code: z.string().optional(), message: z.string().optional() })
    .optional(),
});

type JsonValue = z.core.util.JSONType;

function parseJson(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON: a proxy's or the platform's error page.
    return undefined;
  }
}

async function parse<Schema extends z.ZodType>(
  response: Response,
  schema: Schema
): Promise<z.output<Schema>> {
  const text = await response.text();
  const json = parseJson(text);

  if (!response.ok) {
    const envelope = errorSchema.safeParse(json);
    const error = envelope.success ? envelope.data.error : undefined;

    throw new WorkspaceError(
      response.status,
      error?.message ?? (text.slice(0, 200) || response.statusText),
      error?.code
    );
  }

  const body = schema.safeParse(json);

  if (!body.success) {
    throw new WorkspaceError(
      response.status,
      `Unexpected answer from ${response.url || "the workspace"}: ${z.prettifyError(body.error)}`
    );
  }

  return body.data;
}
