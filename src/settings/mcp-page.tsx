import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Clipboard,
  KeyRound,
  LoaderCircle,
  Plus,
  Trash2,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelHeader,
} from "@/admin/admin-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { api, responseJson } from "@/lib/api";
import type { AccountApiTokenScope } from "../../shared/auth";
import { McpConnectionGuide } from "./mcp-connection-guide";

type CreatedToken = {
  id: string;
  name: string;
  token: string;
  scope: AccountApiTokenScope;
};

const scopeLabels: Record<AccountApiTokenScope, string> = {
  full: "Full access",
  send: "Send only",
};

function formatDate(value: string | Date | null) {
  if (!value) return "Never used";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

async function copy(value: string, label: string) {
  await navigator.clipboard.writeText(value);
  toast.success(`${label} copied`);
}

export function McpSettings() {
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<AccountApiTokenScope>("full");
  const [isCreating, setIsCreating] = useState(false);
  const [createdToken, setCreatedToken] = useState<CreatedToken | null>(null);
  const endpoint = new URL("/mcp", window.location.origin).toString();
  const tokens = useQuery({
    queryKey: ["account-api-tokens"],
    queryFn: async () => responseJson(
      await api.api.auth["api-tokens"].$get(),
    ),
  });
  const revoke = useMutation({
    mutationFn: async (id: string) => responseJson(
      await api.api.auth["api-tokens"][":id"].$delete({ param: { id } }),
    ),
    onSuccess: async () => {
      toast.success("API token revoked");
      await client.invalidateQueries({ queryKey: ["account-api-tokens"] });
    },
    onError: (error) => toast.error(error.message),
  });

  async function submit(event: FormEvent) {
    event.preventDefault();
    const tokenName = name.trim();
    if (!tokenName || isCreating) return;
    setIsCreating(true);
    try {
      const result = await responseJson(
        await api.api.auth["api-tokens"].$post({ json: { name: tokenName, scope } }),
      );
      setName("");
      setScope("full");
      setCreatedToken(result.token);
      await client.invalidateQueries({ queryKey: ["account-api-tokens"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "API token could not be created");
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <TooltipProvider delay={300}>
      <div className={adminPanelClass}>
        <AdminPanelHeader
          Icon={KeyRound}
          title="MCP access"
          description="Personal tokens let an MCP client act through your OpenWorkspace account."
        />
        <AdminPanelBody className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="mcp-endpoint">Server URL</Label>
            <div className="flex gap-2">
              <Input id="mcp-endpoint" value={endpoint} readOnly className="font-mono text-xs" />
              <Tooltip>
                <TooltipTrigger render={<span className="inline-flex" />}>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => void copy(endpoint, "Server URL").catch(() => {
                      toast.error("Server URL could not be copied");
                    })}
                  >
                    <Clipboard />
                    <span className="sr-only">Copy server URL</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Copy server URL</TooltipContent>
              </Tooltip>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Send the token as <code className="font-mono text-foreground/75">Authorization: Bearer …</code>.
              Access always follows your current mailbox permissions and account role.
            </p>
          </div>

          <McpConnectionGuide
            className="border-t border-border/70 pt-5"
            endpoint={endpoint}
          />

          <form className="space-y-3 border-t border-border/70 pt-5" onSubmit={submit}>
            <div className="space-y-2">
              <Label htmlFor="token-name">New token name</Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  id="token-name"
                  value={name}
                  maxLength={80}
                  placeholder="Codex on MacBook"
                  onChange={(event) => setName(event.target.value)}
                />
                <Select
                  value={scope}
                  onValueChange={(value) => setScope(value as AccountApiTokenScope)}
                >
                  <SelectTrigger className="sm:w-40" aria-label="Token access">
                    <SelectValue>{scopeLabels[scope]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="full">{scopeLabels.full}</SelectItem>
                    <SelectItem value="send">{scopeLabels.send}</SelectItem>
                  </SelectContent>
                </Select>
                <Button type="submit" disabled={!name.trim() || isCreating}>
                  {isCreating ? <LoaderCircle className="animate-spin" /> : <Plus />}
                  Create token
                </Button>
              </div>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              The secret is shown once. A full-access token created by an administrator can use administrative tools.
              A send-only token cannot use MCP; it can only list your mailboxes, upload attachments, and send new mail
              through <code className="font-mono text-foreground/75">POST /api/mail/messages</code>, for apps such as invoicing tools.
            </p>
          </form>

          <div className="border-t border-border/70 pt-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold">Active tokens</p>
                <p className="text-xs text-muted-foreground">Revoke tokens you no longer use.</p>
              </div>
              <Badge variant="outline">{tokens.data?.tokens.length ?? 0}</Badge>
            </div>
            {tokens.isLoading ? (
              <div className="flex items-center gap-2 py-5 text-sm text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" /> Loading tokens…
              </div>
            ) : tokens.isError ? (
              <div className="flex items-center justify-between gap-3 py-4">
                <p className="text-sm text-destructive">Could not load API tokens.</p>
                <Button variant="outline" size="sm" onClick={() => void tokens.refetch()}>
                  Retry
                </Button>
              </div>
            ) : tokens.data?.tokens.length ? (
              <div className="divide-y divide-border/70 border-y border-border/70">
                {tokens.data.tokens.map((token) => (
                  <div key={token.id} className="flex items-center gap-4 py-3.5">
                    <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-sunken text-muted-foreground">
                      <KeyRound className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 text-sm font-medium">
                        <span className="truncate">{token.name}</span>
                        {token.scope === "send" ? (
                          <Badge variant="outline">{scopeLabels.send}</Badge>
                        ) : null}
                      </p>
                      <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                        {token.tokenPrefix}… · {formatDate(token.lastUsedAt)}
                      </p>
                    </div>
                    <Tooltip>
                      <TooltipTrigger render={<span className="inline-flex" />}>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          disabled={revoke.isPending}
                          onClick={() => revoke.mutate(token.id)}
                        >
                          {revoke.isPending && revoke.variables === token.id
                            ? <LoaderCircle className="animate-spin" />
                            : <Trash2 />}
                          <span className="sr-only">Revoke {token.name}</span>
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Revoke token</TooltipContent>
                    </Tooltip>
                  </div>
                ))}
              </div>
            ) : (
              <p className="border-y border-border/70 py-5 text-sm text-muted-foreground">
                No API tokens yet.
              </p>
            )}
          </div>
        </AdminPanelBody>
      </div>

      <Dialog
        open={Boolean(createdToken)}
        onOpenChange={(open) => {
          if (!open) setCreatedToken(null);
        }}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Copy your API token</DialogTitle>
            <DialogDescription>
              This secret will not be shown again. Store it in your MCP client's secure configuration.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-xl bg-surface-sunken p-4 font-mono text-xs leading-relaxed break-all ring-1 ring-border">
            {createdToken?.token}
          </div>
          {createdToken?.scope === "full" ? (
            <McpConnectionGuide
              className="border-t border-border/70 pt-4"
              endpoint={endpoint}
              token={createdToken.token}
              title="Copy a ready-to-use config"
            />
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              onClick={() => {
                if (!createdToken) return;
                void copy(createdToken.token, "API token").catch(() => {
                  toast.error("API token could not be copied");
                });
              }}
            >
              <Clipboard /> Copy token
            </Button>
            <Button type="button" variant="outline" onClick={() => setCreatedToken(null)}>
              <Check /> Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}
