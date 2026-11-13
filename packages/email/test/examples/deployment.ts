import * as Cloudflare from "@alchemy.run/cloudflare";
import { OpenWorkspace, providers } from "@open-workspace/core/alchemy";
import * as Alchemy from "alchemy";

import { Email } from "../../alchemy/index.ts";

/*
 * The docs' deployment examples (docs/configuration.md, the README, core's
 * README), typechecked (`bun run typecheck`) but never deployed.
 */

export const minimal = Alchemy.Stack(
  "Workspace",
  { providers: providers(), state: Cloudflare.state() },
  OpenWorkspace({
    hostname: "mail.acme.com",
    mailDomains: ["acme.com"],
    modules: [Email()],
  })
);

export const configured = Alchemy.Stack(
  "Workspace",
  { providers: providers(), state: Cloudflare.state() },
  OpenWorkspace({
    hostname: "mail.example.com",
    mailDomains: ["example.com", "example.org"],
    ai: {
      providers: {
        cloudflare: { type: "cloudflare" },
        anthropic: { type: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" },
      },
      features: {
        classification: {
          enabled: true,
          provider: "cloudflare",
          model: "openai/gpt-6-luna",
          reasoning: "medium",
        },
        translation: {
          enabled: true,
          provider: "anthropic",
          model: "claude-haiku-5-5",
          reasoning: "none",
        },
      },
    },
    modules: [Email({ pushContact: "mailto:it@example.com" })],
  })
);
