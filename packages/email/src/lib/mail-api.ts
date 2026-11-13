import { apiFetch } from "@open-workspace/core/ui";
import { hc } from "hono/client";

import type { MailAppType } from "../../worker/module";

/** Typed client for the mail module's routes. */
export const mailApi = hc<MailAppType>(window.location.origin, {
  fetch: apiFetch,
});
