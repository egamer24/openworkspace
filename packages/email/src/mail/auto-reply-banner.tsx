import { Button, responseJson } from "@open-workspace/core/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Plane } from "lucide-react";
import { Link } from "react-router";
import { toast } from "sonner";

import { mailApi } from "../lib/mail-api";
import { autoReplyQuery } from "../settings/auto-reply-editor";
import type { Mailbox } from "./types";

/** Shown while one of your own mailboxes answers mail automatically, with a quick way out. */
export function AutoReplyBanner({ mailbox }: { mailbox: Mailbox }) {
  const client = useQueryClient();

  const own = useQuery({
    queryKey: ["auto-reply-mailboxes"],
    queryFn: async () =>
      responseJson(await mailApi.api.mail["auto-replies"].$get()),
    staleTime: 5 * 60_000,
  });

  const isOwn = Boolean(
    own.data?.mailboxes.some((candidate) => candidate.id === mailbox.id)
  );

  const query = useQuery({
    ...autoReplyQuery(mailbox.id),
    enabled: isOwn,
    staleTime: 60_000,
  });

  const turnOff = useMutation({
    mutationFn: async () =>
      responseJson(
        await mailApi.api.mail.mailboxes[":id"]["auto-reply"].$patch({
          param: { id: mailbox.id },
          json: { enabled: false },
        })
      ),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["auto-reply", mailbox.id] });
      toast.success("Auto-reply turned off");
    },
    onError: (error) => toast.error(error.message),
  });

  if (!isOwn || query.data?.status !== "active") return null;

  return (
    <div className="border-border bg-primary/10 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3.5 py-2 text-sm">
      <Plane className="text-primary size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        Automatic replies are on for {mailbox.address}.{" "}
        <Link
          to="/settings/auto-reply"
          className="underline underline-offset-2"
        >
          Edit
        </Link>
      </span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={turnOff.isPending}
        onClick={() => turnOff.mutate()}
      >
        {turnOff.isPending && <LoaderCircle className="animate-spin" />}
        Turn off
      </Button>
    </div>
  );
}
