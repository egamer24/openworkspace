import { Hono } from "hono";
import { z } from "zod";

import { setSessionContext } from "./auth/middleware";
import { mockAuthAllowed } from "./auth/mock";
import { sessionUserDetails } from "./auth/permissions";
import { lookupSession } from "./auth/session";
import type { SessionCompanion } from "./auth/session";
import { configuredMailDomains } from "./config/mail-domains";
import { createDb } from "./db/client";
import { users } from "./db/schema";
import type { AppEnv } from "./env";
import { timed } from "./lib/server-timing";
import { zValidator } from "./lib/validator";
import { workspaceModules } from "./modules";
import { brandingQuery, workspaceBranding } from "./workspace-branding";

const installedQuery: SessionCompanion = ({ db }) =>
  db.select({ id: users.id }).from(users).limit(1);

const brandingCompanion: SessionCompanion = ({ db }) => brandingQuery(db);

/** What `installedQuery` and `brandingCompanion` return. */
const installedRowsSchema = z.array(z.object({ id: z.string() }));

const brandingRowsSchema = z.array(
  z.object({ key: z.string(), value: z.string() })
);

const bootstrapQuerySchema = z.object({
  /** The app's URL path; with it, modules add what they show there first. */
  path: z.string().max(2048).optional(),
  /** The URL's query string, with or without "?". */
  search: z.string().max(4096).optional(),
});

/**
 * GET /api/bootstrap, the browser app's first request: whether the workspace
 * is set up, who is signed in, and, given the URL's `path`, what each module
 * shows there first (`WorkspaceModule.bootstrap`), keyed by module name.
 * The session, the installation check, the workspace's branding and the modules'
 * companion statements are one D1 batch; the modules' loads then run in
 * parallel.
 */
export const bootstrapRoutes = new Hono<AppEnv>().get(
  "/",
  zValidator("query", bootstrapQuerySchema),
  async (c) => {
    const query = c.req.valid("query");

    const { path } = query;

    const modules =
      path === undefined
        ? []
        : workspaceModules().flatMap((module) =>
            module.bootstrap ? [{ name: module.name, ...module.bootstrap }] : []
          );

    const lookup = await timed(c, "d1", "session", () =>
      lookupSession(c, [
        installedQuery,
        brandingCompanion,
        ...modules.map(
          (module): SessionCompanion => module.companion ?? (() => null)
        ),
      ])
    );

    const [installed, branding, ...companions] = lookup.companions;
    const installedResult = installedRowsSchema.safeParse(installed);
    const brandingResult = brandingRowsSchema.safeParse(branding);

    // Without a session cookie no companion ran: the same two reads, batched.
    const [installedRows, brandingRows] =
      installedResult.success && brandingResult.success
        ? [installedResult.data, brandingResult.data]
        : await timed(c, "d1", "installed", () => {
            const db = createDb(c.env.DB);

            return db.batch([
              db.select({ id: users.id }).from(users).limit(1),
              brandingQuery(db),
            ]);
          });

    const { logoUrl, name } = workspaceBranding(brandingRows);
    const hasUsers = installedRows.length > 0;
    const { session } = lookup;

    const slices = new Map<string, object>();

    if (session && path !== undefined) {
      setSessionContext(c, session);
      const search = new URLSearchParams(query.search ?? "");
      await Promise.all(
        modules.map(async (module, index) => {
          try {
            slices.set(
              module.name,
              await module.load(c, {
                pathname: path,
                search,
                companion: companions[index],
              })
            );
          } catch (error) {
            // The module's screens ask for their data themselves.
            console.error(
              `Module ${module.name} could not add its startup data`,
              error
            );
          }
        })
      );
    }

    return c.json({
      ok: true as const,
      needsBootstrap: !hasUsers,
      /** Before setup, the mail domains the first administrator's address may use, primary first. */
      setupMailDomains: hasUsers ? [] : configuredMailDomains(),
      authenticated: Boolean(session),
      sessionVersion: session?.authTime.getTime() ?? null,
      user: session ? sessionUserDetails(session.user) : null,
      mockAuthEnabled: mockAuthAllowed(c),
      /** The logo an administrator uploaded, or null. */
      workspaceLogoUrl: logoUrl,
      /** The name an administrator gave the workspace, or null. */
      workspaceName: name,
      /** Each module's startup data, as its client module's `seed` reads it. */
      modules: Object.fromEntries(slices),
    });
  }
);
