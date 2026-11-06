import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./worker/calendar/schema.ts",
  out: "./drizzle/calendar",
  dialect: "sqlite",
  driver: "durable-sqlite",
});

