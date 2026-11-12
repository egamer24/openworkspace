import type { ClientModule } from "@open-workspace/core/ui";
import { NotebookPen, ScrollText } from "lucide-react";
import { lazy } from "react";

import {
  MANAGE_NOTES,
  NOTES_MODULE,
  NOTES_PATH,
  notesWebhookEvents,
} from "../shared/module";

/**
 * Notes' part of the browser app; `Notes()` points the build here. The entry
 * stays light: each screen is its own lazy chunk.
 */
const notes: ClientModule = {
  name: NOTES_MODULE,
  app: { label: "Notes", Icon: NotebookPen, path: NOTES_PATH },
  routes: [
    {
      path: NOTES_PATH,
      Component: lazy(() =>
        import("./notes-page").then((module) => ({ default: module.NotesPage }))
      ),
    },
  ],
  settings: [
    {
      id: "notes",
      label: "Notes",
      description: "How your notes are listed.",
      Icon: NotebookPen,
      Component: lazy(() =>
        import("./notes-settings").then((module) => ({
          default: module.NotesSettings,
        }))
      ),
    },
  ],
  admin: [
    {
      id: "notes",
      label: "Notes",
      Icon: ScrollText,
      permission: MANAGE_NOTES,
      title: "Notes",
      description: "Every note in the workspace, newest first.",
      Component: lazy(() =>
        import("./notes-admin").then((module) => ({
          default: module.NotesAdmin,
        }))
      ),
    },
  ],
  webhookEvents: notesWebhookEvents,
};

export default notes;
