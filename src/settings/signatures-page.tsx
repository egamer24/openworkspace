import { useQueryClient } from "@tanstack/react-query";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { LoaderCircle, PenLine } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelHeader,
} from "@/admin/admin-panel";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ComposerToolbar } from "@/mail/composer-toolbar";
import { api, responseJson } from "@/lib/api";
import type { Mailbox } from "@/mail/types";
import { useMailboxes } from "@/mail/use-mail-data";

/** Tiptap serializes an empty document as a single empty paragraph. */
function isEmptyHtml(html: string) {
  return !html.replace(/<p><\/p>/gu, "").trim();
}

function SignatureEditor({ mailbox }: { mailbox: Mailbox }) {
  const client = useQueryClient();
  const savedHtml = mailbox.signature?.html ?? "";
  const [html, setHtml] = useState(savedHtml);
  const [useOnNew, setUseOnNew] = useState(mailbox.signature?.useOnNew ?? true);
  const [useOnReply, setUseOnReply] = useState(mailbox.signature?.useOnReply ?? true);
  const [saving, setSaving] = useState(false);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        code: false,
        codeBlock: false,
        heading: false,
        horizontalRule: false,
        link: { openOnClick: false, defaultProtocol: "https" },
      }),
      Placeholder.configure({ placeholder: `${mailbox.displayName} · ${mailbox.address}` }),
    ],
    content: savedHtml,
    editorProps: {
      attributes: {
        class: [
          "min-h-24 px-3 py-2.5 text-sm leading-relaxed outline-none",
          "[&_p]:my-0 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5",
          "[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3",
          "[&_a]:text-info [&_a]:underline",
          "[&_.is-editor-empty:first-child::before]:pointer-events-none [&_.is-editor-empty:first-child::before]:float-left [&_.is-editor-empty:first-child::before]:h-0 [&_.is-editor-empty:first-child::before]:text-muted-foreground [&_.is-editor-empty:first-child::before]:content-[attr(data-placeholder)]",
        ].join(" "),
        role: "textbox",
        "aria-label": `Signature for ${mailbox.address}`,
        "aria-multiline": "true",
      },
    },
    onUpdate: ({ editor: current }) => setHtml(current.getHTML()),
  });
  const empty = isEmptyHtml(html);
  const dirty = (empty ? "" : html) !== savedHtml
    || useOnNew !== (mailbox.signature?.useOnNew ?? true)
    || useOnReply !== (mailbox.signature?.useOnReply ?? true);

  async function save() {
    setSaving(true);
    try {
      const result = await responseJson(await api.api.mail.mailboxes[":id"].signature.$put({
        param: { id: mailbox.id },
        json: { html: empty ? "" : html, useOnNew, useOnReply },
      }));
      await client.invalidateQueries({ queryKey: ["mailboxes"] });
      toast.success(result.signature ? "Signature saved" : "Signature removed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Signature could not be saved");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3 py-5 first:pt-0">
      <p className="font-mono text-xs font-medium">{mailbox.address}</p>
      <div className="overflow-hidden rounded-lg border border-input bg-background focus-within:ring-2 focus-within:ring-ring/40">
        <EditorContent editor={editor} />
        <ComposerToolbar editor={editor} disabled={saving} />
      </div>
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
        description="Added to the end of messages you write from each mailbox. Each member of a shared mailbox has their own."
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
              key={`${mailbox.id}:${mailbox.signature?.html ?? ""}`}
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
