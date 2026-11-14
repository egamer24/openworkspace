import {
  Badge,
  Button,
  DateTimePicker,
  Input,
  Label,
  RadioGroup,
  RadioCard,
  Switch,
  responseJson,
  useAddressSection,
} from "@open-workspace/core/ui";
import type { SuccessfulResponse } from "@open-workspace/core/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import type { AutoReplyAudience } from "../../shared/mail";
import { mailApi } from "../lib/mail-api";
import { RichContentEditor } from "./rich-content-editor";
import type { RichContentEditorHandle } from "./rich-content-editor";

const autoReplyRoute = mailApi.api.mail.mailboxes[":id"]["auto-reply"];

export type AutoReplyState = SuccessfulResponse<
  Awaited<ReturnType<typeof autoReplyRoute.$get>>
>;

type SavedMessage = NonNullable<AutoReplyState["settings"]>["inside"];

export function autoReplyQuery(mailboxId: string) {
  return {
    queryKey: ["auto-reply", mailboxId],
    queryFn: async () =>
      responseJson(await autoReplyRoute.$get({ param: { id: mailboxId } })),
  };
}

/** Where the app shows a saved auto-reply image (worker/mail/auto-reply-routes.ts). */
function autoReplyImageUrl(mailboxId: string, contentId: string) {
  return `/api/mail/mailboxes/${encodeURIComponent(mailboxId)}/auto-reply/images/${encodeURIComponent(contentId)}`;
}

function at(value: string | Date | null | undefined) {
  return value
    ? new Date(value).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "";
}

export function autoReplyStatusLabel(state: AutoReplyState) {
  const { status, settings } = state;

  if (status === "scheduled") return `Starts ${at(settings?.startsAt)}`;

  if (status === "active") {
    return settings?.endsAt ? `On until ${at(settings.endsAt)}` : "On";
  }

  if (status === "ended") return `Ended ${at(settings?.endsAt)}`;

  return "Off";
}

function dateOf(value: string | Date | null | undefined) {
  return value ? new Date(value) : null;
}

/** One of the two messages: whether it is sent, its subject and its text. */
function MessageFields({
  id,
  title,
  description,
  mailboxId,
  saved,
  uploadMailboxId,
  enabled,
  onEnabledChange,
  subject,
  onSubjectChange,
  editor,
  onEdit,
  disabled,
  children,
}: {
  id: string;
  title: string;
  description: string;
  mailboxId: string;
  saved: SavedMessage | undefined;
  uploadMailboxId: string | undefined;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  subject: string;
  onSubjectChange: (subject: string) => void;
  editor: React.RefObject<RichContentEditorHandle | null>;
  onEdit: () => void;
  disabled: boolean;
  children?: React.ReactNode;
}) {
  return (
    <fieldset className="border-border/70 min-w-0 space-y-3 rounded-lg border p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <legend className="text-sm font-medium">{title}</legend>
          <p className="text-muted-foreground text-xs">{description}</p>
        </div>
        <Switch
          aria-label={`Reply to ${title.toLowerCase()}`}
          checked={enabled}
          onCheckedChange={onEnabledChange}
        />
      </div>
      {children}
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-subject`}>Subject</Label>
        <Input
          id={`${id}-subject`}
          value={subject}
          maxLength={998}
          placeholder="Auto: <original subject>"
          onChange={(event) => onSubjectChange(event.target.value)}
        />
      </div>
      <RichContentEditor
        ref={editor}
        saved={saved ? { ownerId: mailboxId, ...saved } : null}
        imageUrl={autoReplyImageUrl}
        uploadMailboxId={uploadMailboxId}
        label={`Message to ${title.toLowerCase()}`}
        placeholder="Thanks for your message. I'm away until Monday and will reply when I'm back."
        disabled={disabled}
        onEdit={onEdit}
      />
    </fieldset>
  );
}

/**
 * A mailbox's auto-reply: when it runs, and one message for people inside
 * the workspace and one for everyone else, each in the shared rich content
 * editor and each able to be off. With a Save button of its own, or, inside
 * an address editor (`section`), saved by its "Save address".
 */
function AutoReplyForm({
  mailbox,
  state,
  uploadMailboxId,
  section,
}: {
  mailbox: { id: string; address: string };
  state: AutoReplyState;
  uploadMailboxId: string | undefined;
  section: boolean;
}) {
  const client = useQueryClient();
  const saved = state.settings;
  const id = `auto-reply-${mailbox.id}`;
  const insideEditor = useRef<RichContentEditorHandle>(null);
  const outsideEditor = useRef<RichContentEditorHandle>(null);
  const [edited, setEdited] = useState(false);

  const savedAudience: AutoReplyAudience =
    saved?.outside.audience ?? "everyone";

  const initial = {
    enabled: saved?.enabled ?? false,
    startsAt: dateOf(saved?.startsAt)?.getTime() ?? null,
    endsAt: dateOf(saved?.endsAt)?.getTime() ?? null,
    replyIntervalDays: String(saved?.replyIntervalDays ?? 4),
    insideEnabled: saved?.inside.enabled ?? true,
    insideSubject: saved?.inside.subject ?? "",
    outsideEnabled: saved?.outside.enabled ?? true,
    outsideSubject: saved?.outside.subject ?? "",
    audience: savedAudience,
  };

  const [form, setForm] = useState(initial);

  const update = (patch: Partial<typeof form>) =>
    setForm((current) => ({ ...current, ...patch }));

  const dirty = edited || JSON.stringify(form) !== JSON.stringify(initial);

  async function save() {
    const inside = insideEditor.current?.value();
    const outside = outsideEditor.current?.value();

    if (!inside || !outside) return;

    await responseJson(
      await autoReplyRoute.$put({
        param: { id: mailbox.id },
        json: {
          enabled: form.enabled,
          startsAt: form.startsAt
            ? new Date(form.startsAt).toISOString()
            : null,
          endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : null,
          replyIntervalDays: Math.min(
            30,
            Math.max(1, Math.round(Number(form.replyIntervalDays)) || 4)
          ),
          inside: {
            ...inside,
            enabled: form.insideEnabled,
            subject: form.insideSubject || null,
          },
          outside: {
            ...outside,
            enabled: form.outsideEnabled,
            subject: form.outsideSubject || null,
            audience: form.audience,
          },
        },
      })
    );
    // The form reopens from what was saved (its key is the save time).
    await client.invalidateQueries({ queryKey: ["auto-reply", mailbox.id] });
  }

  // Inside an address editor, its "Save address" saves this; elsewhere a no-op.
  useAddressSection({
    dirty,
    save: () =>
      save().catch((error: Error) => {
        throw new Error(`Auto-reply: ${error.message}`, { cause: error });
      }),
  });

  const saveNow = useMutation({
    mutationFn: save,
    onSuccess: () =>
      toast.success(form.enabled ? "Auto-reply saved" : "Auto-reply is off"),
    onError: (error) => toast.error(error.message),
  });

  const markEdited = () => setEdited(true);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
          <Switch
            checked={form.enabled}
            onCheckedChange={(enabled) => update({ enabled })}
          />
          Send automatic replies from {mailbox.address}
        </label>
        <Badge variant={state.status === "active" ? "default" : "outline"}>
          {autoReplyStatusLabel(state)}
        </Badge>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-start`}>Start</Label>
          <DateTimePicker
            id={`${id}-start`}
            value={form.startsAt === null ? null : new Date(form.startsAt)}
            placeholder="Now"
            onChange={(value) => update({ startsAt: value?.getTime() ?? null })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-end`}>End</Label>
          <DateTimePicker
            id={`${id}-end`}
            value={form.endsAt === null ? null : new Date(form.endsAt)}
            placeholder="Until turned off"
            onChange={(value) => update({ endsAt: value?.getTime() ?? null })}
          />
        </div>
      </div>

      <MessageFields
        id={`${id}-inside`}
        title="People in this workspace"
        description="Senders at the workspace's own mail domains."
        mailboxId={mailbox.id}
        saved={saved?.inside}
        uploadMailboxId={uploadMailboxId}
        enabled={form.insideEnabled}
        onEnabledChange={(insideEnabled) => update({ insideEnabled })}
        subject={form.insideSubject}
        onSubjectChange={(insideSubject) => update({ insideSubject })}
        editor={insideEditor}
        onEdit={markEdited}
        disabled={saveNow.isPending}
      />

      <MessageFields
        id={`${id}-outside`}
        title="People outside the workspace"
        description="Everyone else who writes to this address."
        mailboxId={mailbox.id}
        saved={saved?.outside}
        uploadMailboxId={uploadMailboxId}
        enabled={form.outsideEnabled}
        onEnabledChange={(outsideEnabled) => update({ outsideEnabled })}
        subject={form.outsideSubject}
        onSubjectChange={(outsideSubject) => update({ outsideSubject })}
        editor={outsideEditor}
        onEdit={markEdited}
        disabled={saveNow.isPending}
      >
        <RadioGroup
          className="sm:grid-cols-2"
          aria-label="Who outside the workspace gets it"
          value={form.audience}
          onValueChange={(audience: AutoReplyAudience) => update({ audience })}
        >
          <RadioCard value="everyone" className="text-sm">
            Everyone
          </RadioCard>
          <RadioCard value="knownSenders" className="text-sm">
            Only people this mailbox has written to
          </RadioCard>
        </RadioGroup>
      </MessageFields>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Label htmlFor={`${id}-interval`} className="font-normal">
          The same sender gets at most one reply every
        </Label>
        <Input
          id={`${id}-interval`}
          type="number"
          min={1}
          max={30}
          className="w-16"
          value={form.replyIntervalDays}
          onChange={(event) =>
            update({ replyIntervalDays: event.target.value })
          }
        />
        <span>days</span>
        {section ? null : (
          <Button
            type="button"
            size="sm"
            className="ml-auto"
            disabled={saveNow.isPending || !dirty}
            onClick={() => saveNow.mutate()}
          >
            {saveNow.isPending && <LoaderCircle className="animate-spin" />}
            Save
          </Button>
        )}
      </div>
    </div>
  );
}

/** One mailbox's auto-reply, loaded; Settings, Teams and People use it. */
export function MailboxAutoReply({
  mailbox,
  uploadMailboxId,
  section = false,
}: {
  mailbox: { id: string; address: string };
  /** A mailbox the person can send from, for images. */
  uploadMailboxId: string | undefined;
  section?: boolean;
}) {
  const query = useQuery({ ...autoReplyQuery(mailbox.id), gcTime: 0 });

  if (query.isPending) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 py-2 text-sm">
        <LoaderCircle className="size-4 animate-spin" /> Loading auto-reply…
      </div>
    );
  }

  if (query.isError) {
    return (
      <p className="text-destructive py-2 text-sm">
        The auto-reply for {mailbox.address} couldn't be loaded.
      </p>
    );
  }

  return (
    <AutoReplyForm
      key={String(query.data.settings?.updatedAt ?? "new")}
      mailbox={mailbox}
      state={query.data}
      uploadMailboxId={uploadMailboxId}
      section={section}
    />
  );
}
