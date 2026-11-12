import { apiFetch } from "@open-workspace/core/ui";
import { hc } from "hono/client";

import type { NotesAppType } from "../worker/routes";

/** Typed client for the module's routes; `apiFetch` keeps D1 reads consistent with this tab's writes. */
export const notesApi = hc<NotesAppType>(window.location.origin, {
  fetch: apiFetch,
});

/** Query keys the screens share. */
export const notesKeys = {
  own: ["notes"] as const,
  preferences: ["notes", "preferences"] as const,
  all: ["admin", "notes"] as const,
};

const dateFormat = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatDate(value: string) {
  return dateFormat.format(new Date(value));
}
