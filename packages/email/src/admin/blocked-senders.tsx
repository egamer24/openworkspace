import {
  Button,
  Checkbox,
  Input,
  Skeleton,
  responseJson,
  adminPanelClass,
  AdminPanelBody,
  AdminPanelHeader,
} from "@open-workspace/core/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, LoaderCircle, ShieldBan } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";
import { toast } from "sonner";

import { normalizeBlockPattern } from "../../shared/mail-feedback";
import { mailApi } from "../lib/mail-api";

const BLOCKED_SENDERS_KEY = ["admin-blocked-senders"] as const;

function formatDate(value: string | Date) {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(
    new Date(value)
  );
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

function useWorkspaceBlocks() {
  const client = useQueryClient();

  const invalidate = () =>
    client.invalidateQueries({ queryKey: BLOCKED_SENDERS_KEY });

  const list = useQuery({
    queryKey: BLOCKED_SENDERS_KEY,
    queryFn: async () =>
      responseJson(await mailApi.api.admin["blocked-senders"].$get()),
  });

  const block = useMutation({
    mutationFn: async (input: { pattern: string; moveExisting: boolean }) =>
      responseJson(
        await mailApi.api.admin["blocked-senders"].$post({ json: input })
      ),
    onSuccess: async (result) => {
      const { moved } = result;
      toast.success(`${result.pattern} is blocked for everyone`, {
        description: moved?.conversations
          ? `${plural(moved.conversations, "conversation", "conversations")} moved to Spam in ${plural(moved.mailboxes, "mailbox", "mailboxes")}.`
          : undefined,
      });

      if (moved?.failedMailboxes) {
        toast.warning(
          `Existing mail could not be moved in ${plural(moved.failedMailboxes, "mailbox", "mailboxes")}.`
        );
      }

      await invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  const unblock = useMutation({
    mutationFn: async (pattern: string) =>
      responseJson(
        await mailApi.api.admin["blocked-senders"].$delete({
          query: { pattern },
        })
      ),
    onSuccess: async (_result, pattern) => {
      toast.success(`${pattern} unblocked`);
      await invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  return { list, block, unblock };
}

/** Administration → Blocked senders: addresses and domains blocked for every mailbox. */
export function BlockedSenders() {
  const { list, block, unblock } = useWorkspaceBlocks();
  const [value, setValue] = useState("");
  const [moveExisting, setMoveExisting] = useState(true);
  const pattern = normalizeBlockPattern(value);
  const items = list.data?.blockedSenders ?? [];

  function submit(event: FormEvent) {
    event.preventDefault();

    if (!pattern) return;
    block.mutate({ pattern, moveExisting }, { onSuccess: () => setValue("") });
  }

  return (
    <div className="max-w-4xl">
      <div className={adminPanelClass}>
        <AdminPanelHeader
          Icon={ShieldBan}
          title="Blocked for everyone"
          description="Mail from these senders goes to Spam in every mailbox. Senders are not notified."
        />
        <AdminPanelBody className="space-y-4">
          <form className="space-y-2.5" onSubmit={submit}>
            <div className="flex gap-2">
              <Input
                aria-label="Address or domain to block for everyone"
                placeholder="name@example.com or example.com"
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
              <Button
                type="submit"
                variant="destructive"
                disabled={!pattern || block.isPending}
              >
                {block.isPending ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <ShieldBan />
                )}
                Block
              </Button>
            </div>
            <label className="text-muted-foreground flex items-center gap-2 text-xs">
              <Checkbox
                checked={moveExisting}
                onCheckedChange={(checked) => setMoveExisting(checked === true)}
              />
              Also move mail already delivered from it to Spam
            </label>
          </form>
          {list.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          ) : items.length ? (
            <ul
              aria-label="Senders blocked for everyone"
              className="divide-border/70 border-border divide-y rounded-lg border"
            >
              {items.map((item) => (
                <li
                  key={item.pattern}
                  className="flex items-center gap-3 px-3.5 py-2.5"
                >
                  {item.scope === "domain" ? (
                    <Building2 className="text-muted-foreground size-4 shrink-0" />
                  ) : (
                    <ShieldBan className="text-muted-foreground size-4 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {item.pattern}
                    </span>
                    <span className="text-muted-foreground block truncate text-xs">
                      {item.scope === "domain" ? "Whole domain" : "Address"}
                      {" · "}blocked {formatDate(item.createdAt)}
                      {item.createdByName ? ` by ${item.createdByName}` : ""}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Unblock ${item.pattern}`}
                    disabled={unblock.isPending}
                    onClick={() => unblock.mutate(item.pattern)}
                  >
                    Unblock
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground py-6 text-center text-sm">
              No senders are blocked for everyone.
            </p>
          )}
        </AdminPanelBody>
      </div>
    </div>
  );
}
