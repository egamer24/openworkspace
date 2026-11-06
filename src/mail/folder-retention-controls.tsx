import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, responseJson } from "@/lib/api";

type RetentionFolder = "trash" | "spam";

const PRESET_DAYS = [7, 30, 90];

function daysLabel(days: number | null) {
  return days ? `Auto-delete after ${days} days` : "Keep until emptied";
}

/** Retention and "Empty" for the Trash and Spam views; shown only with send access. */
export function FolderRetentionControls({
  mailboxId,
  folder,
  folderName,
  conversationCount,
}: {
  mailboxId: string;
  folder: RetentionFolder;
  folderName: string;
  conversationCount: number;
}) {
  const client = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [emptying, setEmptying] = useState(false);
  const retention = useQuery({
    queryKey: ["retention", mailboxId],
    queryFn: async ({ signal }) => (await responseJson(
      await api.api.mail.mailboxes[":id"].retention.$get({ param: { id: mailboxId } }, { init: { signal } }),
    )).retention,
  });
  const key = folder === "trash" ? "trashDays" : "spamDays";
  const days = retention.data?.[key] ?? null;
  const options = days && !PRESET_DAYS.includes(days) ? [...PRESET_DAYS, days].sort((a, b) => a - b) : PRESET_DAYS;

  async function setDays(value: string) {
    if (!retention.data) return;
    try {
      await responseJson(await api.api.mail.mailboxes[":id"].retention.$put({
        param: { id: mailboxId },
        json: { ...retention.data, [key]: value === "never" ? null : Number(value) },
      }));
      await client.invalidateQueries({ queryKey: ["retention", mailboxId] });
      toast.success(value === "never"
        ? `${folderName} is kept until you empty it`
        : `${folderName} now deletes conversations after ${value} days`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Retention could not be saved");
    }
  }

  async function empty() {
    setConfirmOpen(false);
    setEmptying(true);
    let deleted = 0;
    try {
      // The server deletes in bounded batches; keep going until nothing is left.
      for (;;) {
        const result = await responseJson(await api.api.mail.mailboxes[":id"].folders[":folder"].empty.$post({
          param: { id: mailboxId, folder },
        }));
        deleted += result.deleted;
        if (!result.remaining || !result.deleted) break;
      }
      toast.success(`${deleted} ${deleted === 1 ? "conversation" : "conversations"} deleted permanently`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `${folderName} could not be emptied`);
    } finally {
      setEmptying(false);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["conversations", mailboxId] }),
        client.invalidateQueries({ queryKey: ["folders", mailboxId] }),
      ]);
    }
  }

  return (
    <>
      <Select
        value={days ? String(days) : "never"}
        disabled={!retention.data}
        onValueChange={(value) => void setDays(String(value))}
      >
        <SelectTrigger size="sm" className="h-8 text-xs" aria-label={`${folderName} retention`}>
          <SelectValue>{daysLabel(days)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="never">Keep until emptied</SelectItem>
          {options.map((option) => (
            <SelectItem key={option} value={String(option)}>Auto-delete after {option} days</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={emptying || conversationCount === 0}
        onClick={() => setConfirmOpen(true)}
      >
        {emptying ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
        Empty {folderName}
      </Button>
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Empty {folderName}?</DialogTitle>
            <DialogDescription>
              All {conversationCount} {conversationCount === 1 ? "conversation" : "conversations"} in {folderName} and their attachments will be deleted for everyone. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
            <Button type="button" variant="destructive" onClick={() => void empty()}>
              Empty {folderName}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
