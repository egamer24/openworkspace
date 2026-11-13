import { Check, Clipboard } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "../components/ui/button";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../components/ui/tabs";
import { cn } from "../lib/utils";

type McpClient = {
  id: string;
  label: string;
  hint: string;
  snippet: (url: string) => string;
  /** What to do after adding the server, when the client does not sign in on its own. */
  signIn?: string;
};

const MCP_CLIENTS: McpClient[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    hint: "Run in your terminal:",
    snippet: (url) => `claude mcp add --transport http openworkspace ${url}`,
    signIn: "Then run /mcp in Claude Code and choose Authenticate.",
  },
  {
    id: "claude",
    label: "Claude",
    hint: "In Claude, open Settings → Connectors → Add custom connector and paste:",
    snippet: (url) => url,
  },
  {
    id: "codex",
    label: "Codex",
    hint: "Add to ~/.codex/config.toml:",
    snippet: (url) =>
      ["[mcp_servers.openworkspace]", `url = "${url}"`].join("\n"),
    signIn: "Then run codex mcp login openworkspace.",
  },
  {
    id: "opencode",
    label: "OpenCode",
    hint: "Add to opencode.jsonc:",
    snippet: (url) =>
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          mcp: {
            openworkspace: { type: "remote", url },
          },
        },
        null,
        2
      ),
    signIn: "Then run opencode mcp auth openworkspace.",
  },
  {
    id: "cursor",
    label: "Cursor",
    hint: "Add to .cursor/mcp.json in your project:",
    snippet: (url) =>
      JSON.stringify({ mcpServers: { openworkspace: { url } } }, null, 2),
  },
  {
    id: "vscode",
    label: "VS Code",
    hint: "Add to .vscode/mcp.json in your project:",
    snippet: (url) =>
      JSON.stringify(
        { servers: { openworkspace: { type: "http", url } } },
        null,
        2
      ),
  },
  {
    id: "windsurf",
    label: "Windsurf",
    hint: "Add to ~/.codeium/windsurf/mcp_config.json:",
    snippet: (url) =>
      JSON.stringify(
        { mcpServers: { openworkspace: { serverUrl: url } } },
        null,
        2
      ),
  },
  {
    id: "zed",
    label: "Zed",
    hint: "Add to your Zed settings.json:",
    snippet: (url) =>
      JSON.stringify({ context_servers: { openworkspace: { url } } }, null, 2),
  },
];

export function McpConnectionGuide({
  className,
  endpoint,
  title = "Connect a client",
}: {
  className?: string;
  endpoint: string;
  title?: string;
}) {
  const [clientId, setClientId] = useState(MCP_CLIENTS[0].id);
  const [copied, setCopied] = useState(false);

  const client =
    MCP_CLIENTS.find((item) => item.id === clientId) ?? MCP_CLIENTS[0];

  const snippet = client.snippet(endpoint);

  async function copySnippet() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      toast.success(`${client.label} config copied`);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Client config could not be copied");
    }
  }

  return (
    <section className={cn("space-y-3", className)}>
      <div>
        <p className="text-sm font-semibold">{title}</p>
        <p className="text-muted-foreground text-xs leading-relaxed">
          Add the server to your MCP client. It opens this site in a browser so
          you can sign in and approve access; no token to copy.
        </p>
      </div>

      <Tabs
        value={clientId}
        onValueChange={(value) => {
          setClientId(String(value));
          setCopied(false);
        }}
        className="gap-2"
      >
        <TabsList aria-label="MCP clients" className="max-w-full">
          {MCP_CLIENTS.map((item) => (
            <TabsTrigger key={item.id} value={item.id} className="flex-none">
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value={clientId} className="space-y-2">
          <p className="text-muted-foreground text-xs">{client.hint}</p>
          <div className="bg-surface-sunken ring-border relative overflow-hidden ring-1">
            <pre className="text-foreground max-h-72 overflow-auto p-4 pr-24 font-mono text-[11px] leading-relaxed">
              {snippet}
            </pre>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="bg-surface/90 absolute top-2 right-2 backdrop-blur-sm"
              onClick={() => void copySnippet()}
            >
              {copied ? <Check /> : <Clipboard />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </TabsContent>
      </Tabs>

      {client.signIn ? (
        <p className="text-muted-foreground text-xs leading-relaxed">
          {client.signIn}
        </p>
      ) : null}
    </section>
  );
}
