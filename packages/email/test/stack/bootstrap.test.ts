import { beforeAll, describe, expect, it } from "bun:test";

import { required } from "@open-workspace/core/shared";
import type { NewEmail } from "@open-workspace/email/worker/mailbox/schema.ts";
import { z } from "zod";

import { readJson } from "./json.ts";
import { bootstrapAdmin, firstMailboxId } from "./mail-flow-helpers.ts";
import { mailbox, useFreshWorkspace, worker } from "./workspace.ts";

useFreshWorkspace();

/**
 * GET /api/bootstrap: the app's first request carries the session and mail's
 * startup data for the URL, read with one D1 batch and one mailbox call.
 */

let cookie: string;
let mailboxId: string;

/** The parts of the bootstrap body these tests read; the rest is kept for whole comparisons. */
const listed = z.looseObject({ id: z.string() });

const bootstrapResponse = z.looseObject({
  modules: z.looseObject({
    email: z
      .looseObject({
        mailboxes: z.array(listed),
        mailbox: z
          .looseObject({
            id: z.string(),
            folders: z.looseObject({ folders: z.array(listed) }),
            conversations: z
              .looseObject({ conversations: z.array(listed) })
              .nullable(),
          })
          .nullable(),
      })
      .optional(),
  }),
});

/** Requests bootstrap as the admin, or with `headers` (`{}` for a signed-out visitor). */
function bootstrap(query = "", headers?: HeadersInit) {
  return worker.fetch(
    new Request(`http://example.test/api/bootstrap${query}`, {
      headers: headers ?? { cookie },
    })
  );
}

async function bootstrapBody(query = "") {
  const response = await bootstrap(query);
  expect(response.status).toBe(200);

  return {
    body: await readJson(response, bootstrapResponse),
    timing: response.headers.get("server-timing") ?? "",
  };
}

/** Mail's part of a bootstrap body, which a signed-in request to a mail path has. */
const mailOf = (body: z.output<typeof bootstrapResponse>) =>
  required(body.modules.email, "bootstrap carries mail's data");

const message = (id: string, at: number): NewEmail => ({
  id,
  conversationId: `conv_${id}`,
  direction: "incoming",
  fromJson: [{ address: "sender@example.net", name: null }],
  toJson: [{ address: "admin@example.test", name: null }],
  subject: `Subject ${id}`,
  preview: id,
  bodyText: id,
  timelineAt: new Date(at),
  transportState: "received",
});

beforeAll(async () => {
  cookie = await bootstrapAdmin();
  mailboxId = await firstMailboxId(cookie);
  await mailbox(mailboxId).seedMailbox(
    [],
    [
      message("msg_boot_1", 1_700_000_000_000),
      message("msg_boot_2", 1_700_000_000_001),
    ]
  );
});

describe("GET /api/bootstrap", () => {
  it("answers signed-out visitors with the workspace state and no module data", async () => {
    const response = await bootstrap("?path=/", {});
    expect(await response.json()).toEqual({
      ok: true,
      needsBootstrap: false,
      setupMailDomains: [],
      authenticated: false,
      sessionVersion: null,
      user: null,
      // Mock sign-in is for localhost only; these requests are for example.test.
      mockAuthEnabled: false,
      workspaceLogoUrl: null,
      workspaceName: null,
      modules: {},
    });
  });

  it("carries the session and, for the mail screen, its mailboxes, folders and first page", async () => {
    const { body, timing } = await bootstrapBody("?path=/&search=");
    expect(body).toMatchObject({
      ok: true,
      authenticated: true,
      user: { name: "Admin" },
    });
    const mail = mailOf(body);
    const opened = required(mail.mailbox, "bootstrap opens the mailbox");

    const conversations = required(
      opened.conversations,
      "bootstrap carries the inbox's first page"
    );

    expect(mail.mailboxes[0]).toMatchObject({ id: mailboxId, unreadCount: 2 });
    expect(opened).toMatchObject({ id: mailboxId, folder: "inbox" });
    expect(
      opened.folders.folders.find((folder) => folder.id === "inbox")
    ).toMatchObject({ totalCount: 2, unreadCount: 2 });
    expect(conversations.conversations.map((item) => item.id)).toEqual([
      "msg_boot_2",
      "msg_boot_1",
    ]);

    // The same data the screen's own requests return.
    const same = async <S extends z.ZodType>(path: string, schema: S) =>
      readJson(
        await worker.fetch(
          new Request(`http://example.test${path}`, { headers: { cookie } })
        ),
        schema
      );

    const { ok: _listOk, ...list } = await same(
      "/api/mail/mailboxes",
      z.looseObject({ ok: z.boolean().optional(), mailboxes: z.array(listed) })
    );

    const { ok: _foldersOk, ...folders } = await same(
      `/api/mail/mailboxes/${mailboxId}/folders`,
      z.looseObject({ ok: z.boolean().optional(), folders: z.array(listed) })
    );

    const { ok: _pageOk, ...page } = await same(
      `/api/mail/conversations?mailboxId=${mailboxId}&folder=inbox&limit=25`,
      z.looseObject({
        ok: z.boolean().optional(),
        conversations: z.array(listed),
      })
    );

    expect(list).toEqual({ mailboxes: mail.mailboxes });
    expect(folders).toEqual(opened.folders);
    expect(page).toEqual(conversations);

    // One D1 round trip for the session, the installation check and the
    // mailbox list; one mailbox call.
    expect(timing.match(/\bd1;/gu)).toHaveLength(1);
    expect(timing.match(/\bdo;/gu)).toHaveLength(1);
  });

  it("opens the mailbox and folder in the URL, and leaves out what the person cannot open", async () => {
    const archived = await bootstrapBody(
      `?path=${encodeURIComponent(`/mail/${mailboxId}/archive/conv_any`)}&search=`
    );

    expect(mailOf(archived.body).mailbox).toMatchObject({
      id: mailboxId,
      folder: "archive",
      conversations: { conversations: [] },
    });

    const unknownFolder = await bootstrapBody(
      `?path=${encodeURIComponent(`/mail/${mailboxId}/nope`)}`
    );

    expect(mailOf(unknownFolder.body).mailbox).toMatchObject({
      id: mailboxId,
      conversations: null,
    });

    const foreign = await bootstrapBody("?path=/mail/mbx_not_mine");
    expect(mailOf(foreign.body)).toMatchObject({ mailbox: null });
    expect(foreign.timing).not.toContain("do;");

    const settings = await bootstrapBody("?path=/settings/sessions");
    expect(mailOf(settings.body).mailbox).toBeNull();
  });

  it("re-reads only the session without a path", async () => {
    const { body, timing } = await bootstrapBody();
    expect(body).toMatchObject({ authenticated: true, modules: {} });
    expect(timing).not.toContain("do;");
  });
});
