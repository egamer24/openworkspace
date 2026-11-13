import type { Context } from "hono";

import type { Database } from "../db/client";
import type { AppEnv } from "../env";
import {
  browserLoginTransaction,
  clearLoginTransactionCookie,
  prepareLoginTransactionCommit,
} from "../oidc/transaction";
import { establishSession } from "./session";

export async function completeOidcLogin(
  db: Database,
  c: Context<AppEnv>,
  userId: string,
  requestId: string
) {
  await browserLoginTransaction(db, c, requestId);
  await establishSession(
    db,
    c,
    userId,
    prepareLoginTransactionCommit(db, requestId, userId)
  );
  clearLoginTransactionCookie(c, requestId);

  return {
    redirectTo: `/oauth/authorize/resume/${encodeURIComponent(requestId)}`,
  };
}
