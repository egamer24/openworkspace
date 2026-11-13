import { Bot, Clipboard, Plug } from "lucide-react";
import { Link } from "react-router";
import { toast } from "sonner";

import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelHeader,
} from "../admin/admin-panel";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { McpConnectionGuide } from "./mcp-connection-guide";

async function copy(value: string, label: string) {
  await navigator.clipboard.writeText(value);
  toast.success(`${label} copied`);
}

export function McpSettings() {
  const endpoint = new URL("/mcp", window.location.origin).toString();

  return (
    <TooltipProvider delay={300}>
      <div className={adminPanelClass}>
        <AdminPanelHeader
          Icon={Bot}
          title="MCP access"
          description="Agents sign in with your account. No tokens."
        />
        <AdminPanelBody className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="mcp-endpoint">Server URL</Label>
            <div className="flex gap-2">
              <Input
                id="mcp-endpoint"
                value={endpoint}
                readOnly
                className="font-mono text-xs"
              />
              <Tooltip>
                <TooltipTrigger render={<span className="inline-flex" />}>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() =>
                      void copy(endpoint, "Server URL").catch(() => {
                        toast.error("Server URL could not be copied");
                      })
                    }
                  >
                    <Clipboard />
                    <span className="sr-only">Copy server URL</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Copy server URL</TooltipContent>
              </Tooltip>
            </div>
            <p className="text-muted-foreground text-xs leading-relaxed">
              When an app connects you choose what it gets: reading, sending or
              organizing mail, or administration you manage. It never goes
              beyond what you can do yourself today.
            </p>
          </div>

          <McpConnectionGuide
            className="border-border/70 border-t pt-5"
            endpoint={endpoint}
          />

          <p className="border-border/70 text-muted-foreground flex items-start gap-2.5 border-t pt-5 text-xs leading-relaxed">
            <Plug className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Clients you approve are listed under{" "}
              <Link
                to="/settings/connected-apps"
                className="text-foreground font-medium underline-offset-4 hover:underline"
              >
                Connected apps
              </Link>
              , where you can see what each may do and disconnect it.
            </span>
          </p>
        </AdminPanelBody>
      </div>
    </TooltipProvider>
  );
}
