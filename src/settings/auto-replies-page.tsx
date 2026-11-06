import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { LoaderCircle, Plane } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelHeader,
} from "@/admin/admin-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, responseJson, type SuccessfulResponse } from "@/lib/api";
import type { Mailbox } from "@/mail/types";
import { useMailboxes } from "@/mail/use-mail-data";

type AutoReplyRoute = (typeof api.api.mail.mailboxes)[":id"]["auto-reply"];
type AutoReplyState = SuccessfulResponse<Awaited<ReturnType<AutoReplyRoute["$get"]>>>;
type Audience = "everyone" | "knownSenders";

function toLocalInput(value: string | Date | null | undefined) {
  return value ? format(new Date(value), "yyyy-MM-dd'T'HH:mm") : "";
}

function fromLocalInput(value: string) {
  return value ? new Date(value).toISOString() : null;
}

function statusLine(state: AutoReplyState) {
  const { status, settings } = state;
  const at = (value: string | Date | null | undefined) =>
    value ? format(new Date(value), "MMM d, HH:mm") : "";
  if (status === "scheduled") return `Scheduled from ${at(settings?.startsAt)}`;
  if (status === "active") return settings?.endsAt ? `On until ${at(settings.endsAt)}` : "On";
  if (status === "ended") return `Ended ${at(settings?.endsAt)}`;
  return "Off";
}

function AutoReplyEditor({ mailbox, state }: { mailbox: Mailbox; state: AutoReplyState }) {
  const client = useQueryClient();
  const saved = state.settings;
  const [enabled, setEnabled] = useState(saved?.enabled ?? false);
  const [startsAt, setStartsAt] = useState(toLocalInput(saved?.startsAt));
  const [endsAt, setEndsAt] = useState(toLocalInput(saved?.endsAt));
  const [subject, setSubject] = useState(saved?.subject ?? "");
  const [bodyText, setBodyText] = useState(saved?.bodyText ?? "");
  const [audience, setAudience] = useState<Audience>(saved?.audience ?? "everyone");
  const [skipInternal, setSkipInternal] = useState(saved?.skipInternal ?? true);
  const [intervalDays, setIntervalDays] = useState(String(saved?.replyIntervalDays ?? 4));
  const [saving, setSaving] = useState(false);
  const id = `auto-reply-${mailbox.id}`;

  async function save() {
    setSaving(true);
    try {
      await responseJson(await api.api.mail.mailboxes[":id"]["auto-reply"].$put({
        param: { id: mailbox.id },
        json: {
          enabled,
          startsAt: fromLocalInput(startsAt),
          endsAt: fromLocalInput(endsAt),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          subject: subject || null,
          bodyText,
          audience,
          skipInternal,
          replyIntervalDays: Math.min(30, Math.max(1, Number(intervalDays) || 4)),
        },
      }));
      await Promise.all([
        client.invalidateQueries({ queryKey: ["auto-reply", mailbox.id] }),
        client.invalidateQueries({ queryKey: ["mailboxes"] }),
      ]);
      toast.success(enabled ? "Auto-reply saved" : "Auto-reply turned off");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Auto-reply could not be saved");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4 py-5 first:pt-0">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={`${id}-enabled`} className="font-mono text-xs">{mailbox.address}</Label>
        <div className="flex items-center gap-3">
          <Badge variant={state.status === "active" ? "default" : "outline"}>{statusLine(state)}</Badge>
          <Switch id={`${id}-enabled`} checked={enabled} onCheckedChange={setEnabled} />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-start`}>Start (optional)</Label>
          <Input id={`${id}-start`} type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-end`}>End (optional)</Label>
          <Input id={`${id}-end`} type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${id}-subject`}>Subject</Label>
        <Input
          id={`${id}-subject`}
          value={subject}
          maxLength={998}
          placeholder="Auto: <original subject>"
          onChange={(event) => setSubject(event.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-body`}>Message</Label>
        <Textarea
          id={`${id}-body`}
          rows={5}
          maxLength={10_000}
          value={bodyText}
          placeholder="Thanks for your message. I'm away until Monday and will reply when I'm back."
          onChange={(event) => setBodyText(event.target.value)}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Reply to</Label>
          <Select value={audience} onValueChange={(value) => setAudience(value as Audience)}>
            <SelectTrigger className="w-full">
              <SelectValue>{audience === "everyone" ? "Everyone" : "Only people I've written to"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="everyone">Everyone</SelectItem>
              <SelectItem value="knownSenders">Only people I've written to</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-interval`}>Reply to the same sender at most every</Label>
          <div className="flex items-center gap-2">
            <Input
              id={`${id}-interval`}
              type="number"
              min={1}
              max={30}
              className="w-20"
              value={intervalDays}
              onChange={(event) => setIntervalDays(event.target.value)}
            />
            <span className="text-sm text-muted-foreground">days</span>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={skipInternal} onCheckedChange={setSkipInternal} />
          Don't reply to other mailboxes on this server
        </label>
        <Button type="button" size="sm" disabled={saving} onClick={() => void save()}>
          {saving ? <LoaderCircle className="animate-spin" /> : null}
          Save
        </Button>
      </div>

      {state.recent.length ? (
        <div className="space-y-1.5 border-t border-border/70 pt-3">
          <p className="text-xs font-semibold text-muted-foreground">Recent auto-replies</p>
          <ul className="space-y-1 text-sm">
            {state.recent.map((entry) => (
              <li key={entry.senderAddress} className="flex justify-between gap-3">
                <span className="truncate">{entry.senderAddress}</span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {format(new Date(entry.repliedAt), "MMM d, HH:mm")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function MailboxAutoReply({ mailbox }: { mailbox: Mailbox }) {
  const query = useQuery({
    queryKey: ["auto-reply", mailbox.id],
    queryFn: async ({ signal }) => responseJson(await api.api.mail.mailboxes[":id"]["auto-reply"].$get(
      { param: { id: mailbox.id } },
      { init: { signal } },
    )),
  });
  if (query.isLoading) {
    return (
      <div className="flex items-center gap-2 py-5 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" /> {mailbox.address}
      </div>
    );
  }
  if (!query.data) {
    return <p className="py-4 text-sm text-destructive">Could not load the auto-reply for {mailbox.address}.</p>;
  }
  return (
    <AutoReplyEditor
      key={String(query.data.settings?.updatedAt ?? "new")}
      mailbox={mailbox}
      state={query.data}
    />
  );
}

export function AutoReplySettings() {
  const mailboxes = useMailboxes();
  const sendable = mailboxes.data?.mailboxes.filter((mailbox) => mailbox.canSend) ?? [];

  return (
    <div className={adminPanelClass}>
      <AdminPanelHeader
        Icon={Plane}
        title="Auto-replies"
        description="Answer incoming mail automatically while you're away. Mailing lists, bounces, other auto-responders and spam are never answered."
      />
      <AdminPanelBody className="divide-y divide-border/70">
        {mailboxes.isLoading ? (
          <div className="flex items-center gap-2 py-5 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" /> Loading mailboxes…
          </div>
        ) : sendable.length ? (
          sendable.map((mailbox) => <MailboxAutoReply key={mailbox.id} mailbox={mailbox} />)
        ) : (
          <p className="py-4 text-sm text-muted-foreground">
            You don't have send access to any mailbox.
          </p>
        )}
      </AdminPanelBody>
    </div>
  );
}
