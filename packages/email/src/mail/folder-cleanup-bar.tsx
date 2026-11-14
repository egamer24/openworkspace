import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  responseJson,
} from "@open-workspace/core/ui";
import { useQueryClient } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { mailApi } from "../lib/mail-api";

function plural(count: number) {
  return `${count} ${count === 1 ? "conversation" : "conversations"}`;
}

/** The server deletes in batches; keeps asking until nothing is left. */
async function emptyAll(mailboxId: string, folder: "trash" | "spam") {
  let deleted = 0;

  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each batch deletes what the last one left
    const result = await responseJson(
      // oxlint-disable-next-line eslint/no-await-in-loop -- same request as above
      await mailApi.api.mail.mailboxes[":id"].folders[":folder"].empty.$post({
        param: { id: mailboxId, folder },
      })
    );

    deleted += result.deleted;

    if (!result.remaining || !result.deleted) return deleted;
  }
}

/**
 * The line above Trash and Spam: how long mail stays (from `Email({ retention })`)
 * and, with send access, "Empty". The caller hides it when the folder is empty.
 */
export function FolderCleanupBar({
  mailboxId,
  folder,
  folderName,
  conversationCount,
  retentionDays,
  canEmpty,
}: {
  mailboxId: string;
  folder: "trash" | "spam";
  folderName: string;
  conversationCount: number;
  retentionDays: number | null;
  canEmpty: boolean;
}) {
  const client = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [emptying, setEmptying] = useState(false);

  if (!retentionDays && !canEmpty) return null;

  async function empty() {
    setConfirmOpen(false);
    setEmptying(true);

    try {
      toast.success(
        `${plural(await emptyAll(mailboxId, folder))} deleted permanently`
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : `${folderName} couldn't be emptied`
      );
    }

    setEmptying(false);
    await Promise.all([
      client.invalidateQueries({ queryKey: ["conversations", mailboxId] }),
      client.invalidateQueries({ queryKey: ["folders", mailboxId] }),
    ]);
  }

  return (
    <>
      <p className="text-muted-foreground border-border flex flex-wrap items-center justify-center gap-x-1 border-b px-4 py-1.5 text-center text-xs">
        {retentionDays && (
          <span>
            Conversations are deleted after {retentionDays}{" "}
            {retentionDays === 1 ? "day" : "days"} in {folderName}.
          </span>
        )}
        {retentionDays && canEmpty && <span aria-hidden>·</span>}
        {canEmpty && (
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            disabled={emptying}
            onClick={() => setConfirmOpen(true)}
          >
            {emptying && <LoaderCircle className="animate-spin" />}
            Empty {folderName}
          </Button>
        )}
      </p>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Empty {folderName}?</AlertDialogTitle>
            <AlertDialogDescription>
              All {plural(conversationCount)} in {folderName} and their
              attachments will be deleted for everyone. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              type="button"
              variant="destructive"
              onClick={() => void empty()}
            >
              Empty {folderName}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
