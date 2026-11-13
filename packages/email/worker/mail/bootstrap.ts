import type { AppEnv, WorkspaceModule } from "@open-workspace/core/module";
import { timed } from "@open-workspace/core/module";
import type { Context } from "hono";
import { z } from "zod";

import { CONVERSATION_PAGE_SIZE } from "../../shared/mail";
import { parseMailPath } from "../../shared/mail-path";
import { mailboxStub } from "../mailbox";
import { mailboxListRowSchema, sessionMailboxListQuery } from "./access";
import type { MailboxListRow } from "./access";
import {
  conversationPageView,
  folderListView,
  mailboxListView,
} from "./routes";

/**
 * The mailbox and folder the mail screen at `pathname` opens: the ones in a
 * /mail/... path, or the first mailbox's Inbox at "/". Other screens show none.
 */
function startupLocation(pathname: string, rows: MailboxListRow[]) {
  if (pathname === "/") {
    return { mailboxId: rows[0]?.id ?? null, folder: "inbox" };
  }

  const route = parseMailPath(pathname);

  return {
    mailboxId: route?.mailboxId ?? null,
    folder: route?.folder ?? "inbox",
  };
}

/**
 * Mail's startup data: the mailbox list (with unread counts, read in the
 * session's D1 batch) and, for the mail screen, its mailbox's folders and the
 * first page of the folder in the URL, from one mailbox call. A mailbox the
 * person cannot open or an unknown folder is left out; the screen's own
 * requests report those.
 */
async function loadMailBootstrap(
  c: Context<AppEnv>,
  input: { pathname: string; search: URLSearchParams; companion: unknown }
) {
  // The rows of sessionMailboxListQuery, which core passes on untyped.
  const rows = z.array(mailboxListRowSchema).parse(input.companion);
  const { mailboxId, folder } = startupLocation(input.pathname, rows);
  const access = rows.find((row) => row.id === mailboxId);

  if (!access) return { ...mailboxListView(rows), mailbox: null };

  const view = await timed(c, "do", "startup", () =>
    mailboxStub(c.env, access.id).startupView(
      c.get("user").id,
      folder,
      CONVERSATION_PAGE_SIZE
    )
  );

  return {
    ...mailboxListView(rows),
    mailbox: {
      id: access.id,
      folder,
      folders: folderListView(view.folders),
      conversations: view.conversations
        ? conversationPageView(view.conversations, access.address)
        : null,
    },
  };
}

export type MailBootstrap = Awaited<ReturnType<typeof loadMailBootstrap>>;

export const mailBootstrap: NonNullable<WorkspaceModule["bootstrap"]> = {
  companion: ({ db, tokenHash, now }) =>
    sessionMailboxListQuery(db, tokenHash, now),
  load: loadMailBootstrap,
};
