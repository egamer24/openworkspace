import { z } from "zod";

export const workspaceBlockSchema = z.object({
  pattern: z.string().trim().min(3).max(320),
  /** Also move mail already delivered from the pattern to Spam in every mailbox. */
  moveExisting: z.boolean().default(true),
});

export const workspaceBlockQuerySchema = z.object({
  pattern: z.string().trim().min(3).max(320),
});
