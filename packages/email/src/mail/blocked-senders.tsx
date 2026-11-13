import { Button, Input, Skeleton } from "@open-workspace/core/ui";
import { Building2, LoaderCircle, ShieldBan } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";
import { toast } from "sonner";

import { normalizeBlockPattern } from "../../shared/mail-feedback";
import {
  useBlockedSenders,
  useBlockSender,
  useUnblockSender,
} from "./use-mail-safety";

/** Blocked tab: per-mailbox blocks with unblock, and the administrator's blocks read-only. */
export function BlockedSendersManager({
  mailboxId,
  active,
}: {
  mailboxId: string;
  active: boolean;
}) {
  const blocked = useBlockedSenders(mailboxId, active);
  const block = useBlockSender();
  const unblock = useUnblockSender();
  const [value, setValue] = useState("");
  const pattern = normalizeBlockPattern(value);

  function submit(event: FormEvent) {
    event.preventDefault();

    if (!pattern) return;
    block.mutate(
      { mailboxId, pattern, moveExisting: false },
      {
        onSuccess: (result) => {
          setValue("");
          toast.success(`Blocked ${result.block.pattern}`);
        },
        onError: (error) => toast.error(error.message),
      }
    );
  }

  const items = blocked.data?.blocked ?? [];
  const workspace = blocked.data?.workspace ?? [];

  return (
    <div className="space-y-3">
      <form className="flex gap-2" onSubmit={submit}>
        <Input
          aria-label="Address or domain to block"
          placeholder="name@example.com or example.com"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <Button
          type="submit"
          variant="outline"
          disabled={!pattern || block.isPending}
        >
          {block.isPending ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <ShieldBan />
          )}
          Block
        </Button>
      </form>
      <div className="border-border/70 max-h-[min(23rem,50vh)] overflow-y-auto border-y">
        {blocked.isLoading ? (
          <div className="space-y-2 py-3">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : items.length || workspace.length ? (
          <ul aria-label="Blocked senders">
            {items.map((item) => (
              <li
                key={item.pattern}
                className="border-border/60 flex min-h-12 items-center gap-3 border-b px-2 py-2 last:border-b-0"
              >
                <ShieldBan className="text-muted-foreground size-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{item.pattern}</p>
                  <p className="text-muted-foreground text-xs">
                    {item.scope === "domain" ? "Whole domain" : "Address"} ·
                    blocked{" "}
                    {new Date(item.blockedAt).toLocaleDateString("en", {
                      dateStyle: "medium",
                    })}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Unblock ${item.pattern}`}
                  disabled={unblock.isPending}
                  onClick={() =>
                    unblock.mutate(
                      { mailboxId, pattern: item.pattern },
                      {
                        onSuccess: () =>
                          toast.success(`Unblocked ${item.pattern}`),
                        onError: (error) => toast.error(error.message),
                      }
                    )
                  }
                >
                  Unblock
                </Button>
              </li>
            ))}
            {workspace.map((item) => (
              <li
                key={`workspace-${item.pattern}`}
                className="border-border/60 flex min-h-12 items-center gap-3 border-b px-2 py-2 last:border-b-0"
              >
                <Building2 className="text-muted-foreground size-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{item.pattern}</p>
                  <p className="text-muted-foreground text-xs">
                    Blocked for everyone by an administrator
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-muted-foreground grid min-h-28 place-items-center px-6 text-center text-sm">
            Blocked senders go straight to Spam. Block one from a message's More
            menu, or add it here.
          </div>
        )}
      </div>
    </div>
  );
}
