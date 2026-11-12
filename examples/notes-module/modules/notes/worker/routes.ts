import {
  apiError,
  createDb,
  createId,
  deferWebhookTask,
  oauthScope,
  queueWebhookEvent,
  requireAuth,
  requirePermission,
  users,
  zValidator,
} from "@open-workspace/core/module";
import type { AppEnv } from "@open-workspace/core/module";
import { required } from "@open-workspace/core/shared";
import { and, asc, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import {
  MANAGE_NOTES,
  MANAGE_NOTES_SCOPE,
  NOTE_BODY_MAX,
  NOTE_CREATED_EVENT,
  NOTE_TITLE_MAX,
  NOTES_READ_SCOPE,
  NOTES_WRITE_SCOPE,
  noteOrders,
} from "../shared/module";
import { notePreferences, notes } from "./schema";

export const noteInputSchema = z.object({
  title: z.string().trim().min(1, "Give the note a title").max(NOTE_TITLE_MAX),
  body: z.string().max(NOTE_BODY_MAX).default(""),
});

const preferencesSchema = z.object({ order: z.enum(noteOrders) });

function publicNote(note: typeof notes.$inferSelect) {
  return {
    id: note.id,
    title: note.title,
    body: note.body,
    createdAt: note.createdAt.toISOString(),
  };
}

/**
 * The signed-in person's own notes, for the browser and, through the MCP
 * server, for apps: every route declares the OAuth scope a token needs.
 */
const ownNotes = new Hono<AppEnv>()
  .use("*", requireAuth)
  .get("/", oauthScope(NOTES_READ_SCOPE), async (c) => {
    const db = createDb(c.env.DB);
    const userId = c.get("user").id;

    const [preferences] = await db
      .select()
      .from(notePreferences)
      .where(eq(notePreferences.userId, userId));

    const order = preferences?.order ?? "newest";

    const rows = await db
      .select()
      .from(notes)
      .where(eq(notes.authorUserId, userId))
      .orderBy(order === "title" ? asc(notes.title) : desc(notes.createdAt));

    return c.json({ ok: true as const, order, notes: rows.map(publicNote) });
  })
  .post(
    "/",
    oauthScope(NOTES_WRITE_SCOPE),
    zValidator("json", noteInputSchema),
    async (c) => {
      const input = c.req.valid("json");
      const user = c.get("user");

      const [note] = await createDb(c.env.DB)
        .insert(notes)
        .values({
          id: createId("note"),
          authorUserId: user.id,
          title: input.title,
          body: input.body,
        })
        .returning();

      const created = publicNote(
        required(note, "the insert returns the note it wrote")
      );

      // Webhooks go out from the queue; a failure to queue never fails the request.
      deferWebhookTask(
        (task) => c.executionCtx.waitUntil(task),
        (eventId) =>
          queueWebhookEvent(c.env, {
            eventId,
            eventType: NOTE_CREATED_EVENT,
            occurredAt: Date.now(),
            source: {
              kind: "data",
              data: { note: created, author: { id: user.id, name: user.name } },
            },
          })
      );

      return c.json({ ok: true as const, note: created }, 201);
    }
  )
  .get("/preferences", oauthScope(NOTES_READ_SCOPE), async (c) => {
    const [row] = await createDb(c.env.DB)
      .select()
      .from(notePreferences)
      .where(eq(notePreferences.userId, c.get("user").id));

    return c.json({ ok: true as const, order: row?.order ?? "newest" });
  })
  .put(
    "/preferences",
    oauthScope(NOTES_WRITE_SCOPE),
    zValidator("json", preferencesSchema),
    async (c) => {
      const { order } = c.req.valid("json");
      await createDb(c.env.DB)
        .insert(notePreferences)
        .values({ userId: c.get("user").id, order })
        .onConflictDoUpdate({ target: notePreferences.userId, set: { order } });

      return c.json({ ok: true as const, order });
    }
  )
  .delete("/:id", oauthScope(NOTES_WRITE_SCOPE), async (c) => {
    const deleted = await createDb(c.env.DB)
      .delete(notes)
      .where(
        and(
          eq(notes.id, c.req.param("id")),
          eq(notes.authorUserId, c.get("user").id)
        )
      )
      .returning({ id: notes.id });

    if (!deleted.length) return apiError(c, 404, "NOT_FOUND", "Note not found");

    return c.json({ ok: true as const });
  });

/**
 * Everyone's notes, under /api/admin/notes, for members given "Manage notes"
 * (administrators always are). Core leaves /api/admin/<section> of a module
 * to the module, so these routes check the permission themselves.
 */
const adminNotes = new Hono<AppEnv>()
  .use(
    "/notes",
    requireAuth,
    requirePermission(MANAGE_NOTES),
    oauthScope(MANAGE_NOTES_SCOPE)
  )
  .use(
    "/notes/*",
    requireAuth,
    requirePermission(MANAGE_NOTES),
    oauthScope(MANAGE_NOTES_SCOPE)
  )
  .get("/notes", async (c) => {
    const rows = await createDb(c.env.DB)
      .select({ note: notes, authorName: users.name })
      .from(notes)
      .innerJoin(users, eq(users.id, notes.authorUserId))
      .orderBy(desc(notes.createdAt));

    return c.json({
      ok: true as const,
      notes: rows.map((row) => ({
        ...publicNote(row.note),
        authorName: row.authorName,
      })),
    });
  })
  .delete("/notes/:id", async (c) => {
    const deleted = await createDb(c.env.DB)
      .delete(notes)
      .where(eq(notes.id, c.req.param("id")))
      .returning({ id: notes.id });

    if (!deleted.length) return apiError(c, 404, "NOT_FOUND", "Note not found");

    return c.json({ ok: true as const });
  });

/** Routes under /api: the browser's, and the MCP tools' backend. */
export const notesAccountApi = new Hono<AppEnv>()
  .route("/notes", ownNotes)
  .route("/admin", adminNotes);

/** The module's routes as the browser's typed client sees them. */
export const notesBrowserApi = new Hono<AppEnv>().route(
  "/api",
  notesAccountApi
);

export type NotesAppType = typeof notesBrowserApi;
