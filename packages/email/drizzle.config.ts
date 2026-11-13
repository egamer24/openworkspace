import { defineConfig } from "drizzle-kit";

// The mail module's D1 tables; they sit in the workspace database next to core's.
export default defineConfig({
  schema: "./worker/db/schema.ts",
  out: "./migrations",
  dialect: "sqlite",
});
