import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./worker/mailbox/schema.ts",
  out: "./drizzle/mailbox",
  dialect: "sqlite",
  driver: "durable-sqlite",
});
