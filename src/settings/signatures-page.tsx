import { useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, PenLine } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelHeader,
} from "@/admin/admin-panel";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, responseJson } from "@/lib/api";
import type { Mailbox } from "@/mail/types";
import { useMailboxes } from "@/mail/use-mail-data";

const MAX_SIGNATURE_LENGTH = 2_000;

function SignatureEditor({ mailbox }: { mailbox: Mailbox }) {
  const client = useQueryClient();
  const [text, setText] = useState(mailbox.signature?.text ?? "");
  const [useOnNew, setUseOnNew] = useState(mailbox.signature?.useOnNew ?? true);
  const [useOnReply, setUseOnReply] = useState(mailbox.signature?.useOnReply ?? true);
  const [saving, setSaving] = useState(false);
  const dirty = text.trim() !== (mailbox.signature?.text ?? "")
    || useOnNew !== (mailbox.signature?.useOnNew ?? true)
    || useOnReply !== (mailbox.signature?.useOnReply ?? true);
  const id = `signature-${mailbox.id}`;

  async function save() {
    setSaving(true);
    try {
      await responseJson(await api.api.mail.mailboxes[":id"].signature.$put({
        param: { id: mailbox.id },
        json: { text, useOnNew, useOnReply },
      }));
      await client.invalidateQueries({ queryKey: ["mailboxes"] });
      toast.success(text.trim() ? "Signature saved" : "Signature removed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Signature could not be saved");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3 py-5 first:pt-0">
      <Label htmlFor={id} className="font-mono text-xs">{mailbox.address}</Label>
      <Textarea
        id={id}
        value={text}
        maxLength={MAX_SIGNATURE_LENGTH}
        rows={4}
        placeholder={`${mailbox.displayName}\n${mailbox.address}`}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={useOnNew} onCheckedChange={setUseOnNew} />
          New messages
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={useOnReply} onCheckedChange={setUseOnReply} />
          Replies and forwards
        </label>
        <Button
          type="button"
          size="sm"
          className="ml-auto"
          disabled={!dirty || saving}
          onClick={() => void save()}
        >
          {saving ? <LoaderCircle className="animate-spin" /> : null}
          Save
        </Button>
      </div>
    </div>
  );
}

export function SignatureSettings() {
  const mailboxes = useMailboxes();
  const sendable = mailboxes.data?.mailboxes.filter((mailbox) => mailbox.canSend) ?? [];

  return (
    <div className={adminPanelClass}>
      <AdminPanelHeader
        Icon={PenLine}
        title="Signatures"
        description="Plain text added to the end of messages you write from each mailbox. Each member of a shared mailbox has their own."
      />
      <AdminPanelBody className="divide-y divide-border/70">
        {mailboxes.isLoading ? (
          <div className="flex items-center gap-2 py-5 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" /> Loading mailboxes…
          </div>
        ) : mailboxes.isError ? (
          <p className="py-4 text-sm text-destructive">Could not load mailboxes.</p>
        ) : sendable.length ? (
          sendable.map((mailbox) => (
            <SignatureEditor
              key={`${mailbox.id}:${mailbox.signature?.text ?? ""}`}
              mailbox={mailbox}
            />
          ))
        ) : (
          <p className="py-4 text-sm text-muted-foreground">
            You don't have send access to any mailbox.
          </p>
        )}
      </AdminPanelBody>
    </div>
  );
}
