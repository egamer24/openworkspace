import type { Context } from "hono";

import type { Database } from "../db/client";
import type { AppEnv } from "../env";
import {
  browserSamlTransaction,
  clearSamlTransactionCookie,
  prepareSamlTransactionCommit,
} from "../saml/transaction";
import { establishSession } from "./session";

export async function completeSamlLogin(
  db: Database,
  c: Context<AppEnv>,
  userId: string,
  requestId: string
) {
  await browserSamlTransaction(db, c, requestId);
  await establishSession(
    db,
    c,
    userId,
    prepareSamlTransactionCommit(db, requestId, userId)
  );
  clearSamlTransactionCookie(c, requestId);

  return { redirectTo: `/saml/resume/${encodeURIComponent(requestId)}` };
}
