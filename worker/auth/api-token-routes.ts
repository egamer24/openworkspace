import { zValidator } from "@hono/zod-validator";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { createDb } from "../db/client";
import { accountApiTokens } from "../db/schema";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import {
  AccountApiTokenLimitError,
  createAccountApiToken,
} from "./api-tokens";
import { requireSessionAuth } from "./middleware";
import { createAccountApiTokenSchema } from "./schemas";

export const accountApiTokenRoutes = new Hono<AppEnv>()
  .use("*", requireSessionAuth)
  .get("/", async (c) => {
    const tokens = await createDb(c.env.DB)
      .select({
        id: accountApiTokens.id,
        name: accountApiTokens.name,
        tokenPrefix: accountApiTokens.tokenPrefix,
        scope: accountApiTokens.scope,
        lastUsedAt: accountApiTokens.lastUsedAt,
        createdAt: accountApiTokens.createdAt,
      })
      .from(accountApiTokens)
      .where(eq(accountApiTokens.userId, c.get("user").id))
      .orderBy(desc(accountApiTokens.createdAt));
    return c.json({ ok: true as const, tokens });
  })
  .post("/", zValidator("json", createAccountApiTokenSchema), async (c) => {
    try {
      const { name, scope } = c.req.valid("json");
      const token = await createAccountApiToken(
        createDb(c.env.DB),
        c.get("user").id,
        name,
        scope,
      );
      return c.json({ ok: true as const, token }, 201);
    } catch (error) {
      if (!(error instanceof AccountApiTokenLimitError)) throw error;
      return apiError(
        c,
        409,
        "CONFLICT",
        error.message,
      );
    }
  })
  .delete("/:id", async (c) => {
    const deleted = await createDb(c.env.DB)
      .delete(accountApiTokens)
      .where(and(
        eq(accountApiTokens.id, c.req.param("id")),
        eq(accountApiTokens.userId, c.get("user").id),
      ))
      .returning({ id: accountApiTokens.id });
    if (deleted.length === 0) {
      return apiError(c, 404, "NOT_FOUND", "API token not found");
    }
    return c.json({ ok: true as const });
  });
