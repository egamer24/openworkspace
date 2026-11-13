import { z } from "zod";

/** An id argument of an MCP tool. */
export const entityIdSchema = z.string().trim().min(1).max(255);
