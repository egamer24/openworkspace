import { defineConfig } from "drizzle-kit";

// The module's D1 tables. Migrations ship with the module and run on deploy,
// recorded as modules/notes/<file>: never rename the module or its files.
export default defineConfig({
  schema: "./worker/schema.ts",
  out: "./migrations",
  dialect: "sqlite",
});
