import { describe, expect, it } from "bun:test";

import { workspaceOrigin } from "../../alchemy/origin.ts";

describe("the app's origin from OpenWorkspace({ hostname })", () => {
  it("is https://<hostname> when deployed, normalized", () => {
    expect(workspaceOrigin(" Mail.Example.COM ", false)).toBe(
      "https://mail.example.com"
    );
  });

  it("fails the deploy for anything but a bare domain name", () => {
    for (const hostname of [
      "",
      "localhost:5173",
      "https://mail.example.com",
      "mail.example.com/app",
      "not a host",
    ]) {
      expect(() => workspaceOrigin(hostname, false), hostname).toThrow(
        "OpenWorkspace options are invalid:\n  hostname:"
      );
    }
  });

  it("is http://<host> under alchemy dev, where local stacks name their host and port", () => {
    expect(workspaceOrigin("localhost:5173", true)).toBe(
      "http://localhost:5173"
    );
    expect(workspaceOrigin("127.0.0.1:4173", true)).toBe(
      "http://127.0.0.1:4173"
    );
    expect(workspaceOrigin("example.test", true)).toBe("http://example.test");
    expect(() => workspaceOrigin("http://localhost:5173", true)).toThrow(
      "hostname: Use a host such as localhost:5173"
    );
  });

  it("is the local dev server under alchemy dev when a deployment's project names its real hostname", () => {
    expect(workspaceOrigin("mail.acme.com", true, { port: 5173 })).toBe(
      "http://localhost:5173"
    );
    expect(
      workspaceOrigin("mail.acme.com", true, { host: "127.0.0.1", port: 4000 })
    ).toBe("http://127.0.0.1:4000");
    expect(workspaceOrigin("localhost:5173", true, { port: 4000 })).toBe(
      "http://localhost:5173"
    );
    expect(workspaceOrigin("mail.acme.com", false, { port: 5173 })).toBe(
      "https://mail.acme.com"
    );
    expect(workspaceOrigin("example.test", true, { port: 4000 })).toBe(
      "http://example.test"
    );
  });
});
