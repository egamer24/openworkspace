import { useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Plane } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api, responseJson } from "@/lib/api";
import type { Mailbox } from "./types";

/** Shown while a mailbox is answering mail automatically. */
export function AutoReplyBanner({ mailbox }: { mailbox: Mailbox }) {
  const client = useQueryClient();
  const [turningOff, setTurningOff] = useState(false);
  if (mailbox.autoReply !== "active") return null;

  async function turnOff() {
    setTurningOff(true);
    try {
      const route = api.api.mail.mailboxes[":id"]["auto-reply"];
      const current = await responseJson(await route.$get({ param: { id: mailbox.id } }));
      const settings = current.settings;
      await responseJson(await route.$put({
        param: { id: mailbox.id },
        json: {
          enabled: false,
          startsAt: settings?.startsAt ? new Date(settings.startsAt).toISOString() : null,
          endsAt: settings?.endsAt ? new Date(settings.endsAt).toISOString() : null,
          timeZone: settings?.timeZone ?? null,
          subject: settings?.subject ?? null,
          bodyText: settings?.bodyText ?? "",
          audience: settings?.audience ?? "everyone",
          skipInternal: settings?.skipInternal ?? true,
          replyIntervalDays: settings?.replyIntervalDays ?? 4,
        },
      }));
      await Promise.all([
        client.invalidateQueries({ queryKey: ["mailboxes"] }),
        client.invalidateQueries({ queryKey: ["auto-reply", mailbox.id] }),
      ]);
      toast.success("Auto-reply turned off");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Auto-reply could not be turned off");
    } finally {
      setTurningOff(false);
    }
  }

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-primary/10 px-5 py-2 text-sm">
      <Plane className="size-4 shrink-0 text-primary" />
      <span className="min-w-0 flex-1">
        Automatic replies are on for {mailbox.address}.{" "}
        <Link to="/settings/auto-replies" className="underline underline-offset-2">Edit</Link>
      </span>
      <Button type="button" size="sm" variant="outline" disabled={turningOff} onClick={() => void turnOff()}>
        {turningOff ? <LoaderCircle className="animate-spin" /> : null}
        Turn off
      </Button>
    </div>
  );
}
