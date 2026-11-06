import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Save, ShieldAlert } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelFooter,
  AdminPanelHeader,
} from "@/admin/admin-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { api, responseJson } from "@/lib/api";
import { useMailboxes } from "@/mail/use-mail-data";
import type { Mailbox, SpamSettings as SpamSettingsValue } from "@/mail/types";

export function SpamSettings() {
  const mailboxes = useMailboxes();
  const sendable = mailboxes.data?.mailboxes.filter((mailbox) => mailbox.canSend) ?? [];

  if (mailboxes.isLoading) return <Skeleton className="h-64 w-full" />;
  if (mailboxes.isError) {
    return (
      <div className="flex items-center justify-between gap-4 py-4">
        <p className="text-sm text-destructive">Could not load mailboxes.</p>
        <Button variant="outline" size="sm" onClick={() => void mailboxes.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  if (!sendable.length) {
    return (
      <p className="text-sm text-muted-foreground">
        You need send access to a mailbox to change its spam filter.
      </p>
    );
  }
  return (
    <div className="space-y-6">
      {sendable.map((mailbox) => (
        <MailboxSpamSettings key={mailbox.id} mailbox={mailbox} />
      ))}
    </div>
  );
}

function MailboxSpamSettings({ mailbox }: { mailbox: Mailbox }) {
  const settings = useQuery({
    queryKey: ["mailbox-spam", mailbox.id],
    queryFn: async () => responseJson(
      await api.api.mail.mailboxes[":id"].spam.$get({ param: { id: mailbox.id } }),
    ),
  });

  return (
    <div className={adminPanelClass}>
      <AdminPanelHeader
        Icon={ShieldAlert}
        title={mailbox.displayName || mailbox.address}
        description={mailbox.address}
      />
      {settings.data ? (
        <SpamSettingsForm
          key={JSON.stringify(settings.data.settings)}
          mailboxId={mailbox.id}
          initial={settings.data.settings}
        />
      ) : settings.isError ? (
        <AdminPanelBody className="flex items-center justify-between gap-4">
          <p className="text-sm text-destructive">Could not load spam settings.</p>
          <Button variant="outline" size="sm" onClick={() => void settings.refetch()}>
            Retry
          </Button>
        </AdminPanelBody>
      ) : (
        <AdminPanelBody>
          <Skeleton className="h-40 w-full" />
        </AdminPanelBody>
      )}
    </div>
  );
}

function lines(value: string) {
  return value.split(/[\s,]+/u).map((item) => item.trim()).filter(Boolean);
}

function SpamSettingsForm({
  mailboxId,
  initial,
}: {
  mailboxId: string;
  initial: SpamSettingsValue;
}) {
  const client = useQueryClient();
  const [spamThreshold, setSpamThreshold] = useState(initial.spamThreshold);
  const [suspiciousThreshold, setSuspiciousThreshold] = useState(initial.suspiciousThreshold);
  const [allow, setAllow] = useState(initial.allow.join("\n"));
  const [block, setBlock] = useState(initial.block.join("\n"));
  const save = useMutation({
    mutationFn: async (input: SpamSettingsValue) => responseJson(
      await api.api.mail.mailboxes[":id"].spam.$put({
        param: { id: mailboxId },
        json: input,
      }),
    ),
    onSuccess: (result) => {
      client.setQueryData(["mailbox-spam", mailboxId], result);
      toast.success("Spam filter updated");
    },
    onError: (error) => toast.error(error.message),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate({
      spamThreshold,
      suspiciousThreshold,
      allow: lines(allow),
      block: lines(block),
    });
  }

  const id = (name: string) => `spam-${name}-${mailboxId}`;
  return (
    <form onSubmit={submit}>
      <AdminPanelBody className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={id("threshold")}>Move to Spam at</Label>
            <Input
              id={id("threshold")}
              className="w-24 tabular-nums"
              type="number"
              min={suspiciousThreshold + 1}
              max={100}
              required
              value={spamThreshold}
              onChange={(event) => setSpamThreshold(Number(event.target.value))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={id("suspicious")}>Mark suspicious at</Label>
            <Input
              id={id("suspicious")}
              className="w-24 tabular-nums"
              type="number"
              min={1}
              max={spamThreshold - 1}
              required
              value={suspiciousThreshold}
              onChange={(event) => setSuspiciousThreshold(Number(event.target.value))}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Scores run from 0 to 100. Suspicious mail stays in Inbox with a warning.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={id("allow")}>Always allow</Label>
            <Textarea
              id={id("allow")}
              className="min-h-28 resize-y font-mono text-xs"
              placeholder={"colleague@example.com\npartner.example"}
              value={allow}
              onChange={(event) => setAllow(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={id("block")}>Always block</Label>
            <Textarea
              id={id("block")}
              className="min-h-28 resize-y font-mono text-xs"
              placeholder="spammer.example"
              value={block}
              onChange={(event) => setBlock(event.target.value)}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          One address or domain per line. A domain also matches its subdomains, and the allow list wins.
        </p>
      </AdminPanelBody>
      <AdminPanelFooter>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? <LoaderCircle className="animate-spin" /> : <Save />}
          Save
        </Button>
      </AdminPanelFooter>
    </form>
  );
}
