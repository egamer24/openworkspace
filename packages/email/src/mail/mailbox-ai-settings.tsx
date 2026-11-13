import {
  Badge,
  Button,
  DialogFooter,
  Input,
  Label,
  Skeleton,
  Textarea,
  responseJson,
} from "@open-workspace/core/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Save } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";
import { toast } from "sonner";

import { mailApi } from "../lib/mail-api";
import type {
  MailboxAiConfiguration,
  MailboxAiSettings as MailboxAiSettingsValue,
} from "./types";

export function MailboxAiSettings({
  mailboxId,
  active,
}: {
  mailboxId: string;
  active: boolean;
}) {
  const settings = useQuery({
    queryKey: ["mailbox-ai", mailboxId],
    queryFn: async () =>
      responseJson(
        await mailApi.api.mail.mailboxes[":id"].ai.$get({
          param: { id: mailboxId },
        })
      ),
    enabled: active,
  });

  if (settings.isLoading) {
    return (
      <div className="space-y-4 py-2">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
    );
  }

  if (settings.isError) {
    return (
      <div className="border-border/70 flex items-center justify-between gap-4 border-y py-4">
        <p className="text-muted-foreground text-sm">
          Mailbox AI settings are unavailable.
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={() => void settings.refetch()}
        >
          Try again
        </Button>
      </div>
    );
  }

  return settings.data ? (
    <MailboxAiSettingsForm
      key={`${mailboxId}:${settings.data.settings.configuration.instructions}:${settings.data.settings.configuration.confidenceThreshold}`}
      mailboxId={mailboxId}
      initial={settings.data.settings}
    />
  ) : null;
}

function MailboxAiSettingsForm({
  mailboxId,
  initial,
}: {
  mailboxId: string;
  initial: MailboxAiSettingsValue;
}) {
  const client = useQueryClient();
  const [configuration, setConfiguration] = useState(initial.configuration);

  const save = useMutation({
    mutationFn: async (input: MailboxAiConfiguration) =>
      responseJson(
        await mailApi.api.mail.mailboxes[":id"].ai.$put({
          param: { id: mailboxId },
          json: input,
        })
      ),
    onSuccess: async (result) => {
      setConfiguration(result.settings.configuration);
      toast.success("Mailbox AI rules updated");
      await client.invalidateQueries({ queryKey: ["mailbox-ai", mailboxId] });
    },
    onError: (error) => toast.error(error.message),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate(configuration);
  }

  return (
    <form className="space-y-5" onSubmit={submit}>
      <div className="border-border/70 flex items-start justify-between gap-4 border-y py-4">
        <div>
          <p className="text-sm font-medium">Processing status</p>
          <p className="text-muted-foreground mt-1 text-xs">
            Set for the whole workspace in its configuration. Your settings are
            kept while it is off.
          </p>
        </div>
        <Badge variant={initial.globalEnabled ? "default" : "outline"}>
          {initial.globalEnabled ? "Enabled" : "Off"}
        </Badge>
      </div>

      <div className="space-y-2">
        <Label htmlFor={`mailbox-ai-confidence-${mailboxId}`}>
          Minimum confidence
        </Label>
        <div className="flex items-center gap-2">
          <Input
            id={`mailbox-ai-confidence-${mailboxId}`}
            className="w-24 tabular-nums"
            type="number"
            min={50}
            max={100}
            step={5}
            required
            value={configuration.confidenceThreshold}
            onChange={(event) =>
              setConfiguration({
                ...configuration,
                confidenceThreshold: Number(event.target.value),
              })
            }
          />
          <span className="text-muted-foreground text-sm">%</span>
        </div>
        <p className="text-muted-foreground text-xs">
          Lower-confidence decisions stay in Inbox.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor={`mailbox-ai-instructions-${mailboxId}`}>
          Classification rules
        </Label>
        <Textarea
          id={`mailbox-ai-instructions-${mailboxId}`}
          className="min-h-32 resize-y"
          maxLength={4000}
          placeholder="For example: partnership requests go to Product. Treat newsletters as spam only when clearly unsolicited."
          value={configuration.instructions}
          onChange={(event) =>
            setConfiguration({
              ...configuration,
              instructions: event.target.value,
            })
          }
        />
        <p className="text-muted-foreground text-xs">
          Refer to custom folders by the names shown in navigation. If nothing
          matches, mail stays in Inbox.
        </p>
      </div>

      <DialogFooter>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <Save />
          )}
          Save rules
        </Button>
      </DialogFooter>
    </form>
  );
}
