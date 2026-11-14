import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TooltipProvider,
  responseJson,
} from "@open-workspace/core/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Folder,
  FolderCog,
  ListFilter,
  LoaderCircle,
  Pencil,
  Plus,
  ShieldBan,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { toast } from "sonner";

import {
  folderOrderPositions,
  moveFolderInOrder,
} from "../../shared/folder-order";
import { mailApi } from "../lib/mail-api";
import { BlockedSendersManager } from "./blocked-senders";
import { FolderGlyph } from "./folder-glyph";
import { orderedFolders } from "./mail-folders";
import { foldersQuery } from "./mail-queries";
import { MailboxAiSettings } from "./mailbox-ai-settings";
import { MailboxRules } from "./mailbox-rules";
import { ToolbarTooltip } from "./toolbar-tooltip";
import type { MailFolder } from "./types";

type FolderOperation =
  | { type: "create"; name: string }
  | { type: "rename"; folderId: string; name: string }
  | { type: "delete"; folderId: string };

/**
 * The "Folders & AI sorting" dialog with its own trigger button. With
 * `controlled`, the caller opens it and no trigger is drawn, e.g. from the
 * gear at the end of the phone's dock.
 */
export function FolderManager({
  mailboxId,
  activeFolderId,
  folders,
  onSelectFolder,
  controlled,
}: {
  mailboxId: string;
  activeFolderId: string;
  folders: MailFolder[];
  onSelectFolder: (folderId: string) => void;
  controlled?: { open: boolean; onOpenChange: (open: boolean) => void };
}) {
  const client = useQueryClient();

  // Every folder but Inbox, which stays first: system folders move too, but keep their names.
  const orderable = orderedFolders(folders).filter(
    (folder) => folder.id !== "inbox"
  );

  const hasCustomFolders = orderable.some((folder) => folder.kind === "custom");
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlled ? controlled.open : ownOpen;
  const setOpen = controlled ? controlled.onOpenChange : setOwnOpen;
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  const [deleteCandidate, setDeleteCandidate] = useState<MailFolder | null>(
    null
  );

  const [section, setSection] = useState("folders");

  const mutation = useMutation({
    mutationFn: async (operation: FolderOperation) => {
      if (operation.type === "create") {
        return responseJson(
          await mailApi.api.mail.mailboxes[":id"].folders.$post({
            param: { id: mailboxId },
            json: { name: operation.name },
          })
        );
      }

      if (operation.type === "rename") {
        return responseJson(
          await mailApi.api.mail.mailboxes[":id"].folders[":folderId"].$patch({
            param: { id: mailboxId, folderId: operation.folderId },
            json: { name: operation.name },
          })
        );
      }

      return responseJson(
        await mailApi.api.mail.mailboxes[":id"].folders[":folderId"].$delete({
          param: { id: mailboxId, folderId: operation.folderId },
        })
      );
    },
    onSuccess: async (_result, operation) => {
      if (operation.type === "create") {
        setNewName("");
        toast.success("Folder created");
      } else if (operation.type === "rename") {
        setEditingId(null);
        toast.success("Folder renamed");
      } else if (operation.type === "delete") {
        setDeleteCandidate(null);

        if (operation.folderId === activeFolderId) onSelectFolder("inbox");
        toast.success("Folder deleted; its conversations moved to Inbox");
      }

      await Promise.all([
        client.invalidateQueries({ queryKey: ["folders", mailboxId] }),
        client.invalidateQueries({ queryKey: ["conversations", mailboxId] }),
      ]);
    },
    onError: async (error) => {
      toast.error(error.message);
      await client.invalidateQueries({ queryKey: ["folders", mailboxId] });
    },
  });

  const folderQueryKey = foldersQuery(mailboxId).queryKey;
  const reorderKey = ["folder-order", mailboxId];

  // Moves show at once and queue one after another, so the arrows stay
  // enabled (and keep keyboard focus) while earlier moves are saving.
  const reorder = useMutation({
    mutationKey: reorderKey,
    scope: { id: `folder-order:${mailboxId}` },
    mutationFn: async (folderIds: string[]) =>
      responseJson(
        await mailApi.api.mail.mailboxes[":id"].folders.order.$put({
          param: { id: mailboxId },
          json: { folderIds },
        })
      ),
    onMutate: async (folderIds) => {
      await client.cancelQueries({ queryKey: folderQueryKey });

      const positions = new Map(
        folderOrderPositions(folderIds).map((item) => [item.id, item.sortOrder])
      );

      client.setQueryData(
        folderQueryKey,
        (data) =>
          data && {
            ...data,
            folders: data.folders.map((folder) => ({
              ...folder,
              sortOrder: positions.get(folder.id) ?? folder.sortOrder,
            })),
          }
      );
    },
    onError: (error) => {
      // A conflict means this client's folder list is stale; the refresh below brings the real order back.
      toast.error(error.message);
    },
    onSettled: async () => {
      if (client.isMutating({ mutationKey: reorderKey }) > 1) return;
      await client.invalidateQueries({ queryKey: folderQueryKey });
    },
  });

  function createFolder(event: FormEvent) {
    event.preventDefault();
    const name = newName.trim();

    if (name) mutation.mutate({ type: "create", name });
  }

  function renameFolder(event: FormEvent, folderId: string) {
    event.preventDefault();
    const name = editingName.trim();

    if (name) mutation.mutate({ type: "rename", folderId, name });
  }

  // A moved row's arrow keeps focus, so the keyboard can press it again; at
  // either end, where that arrow turns off, focus goes to the other one.
  const folderList = useRef<HTMLDivElement>(null);

  const [moved, setMoved] = useState<{
    folderId: string;
    direction: -1 | 1;
  } | null>(null);

  // Where the moved folder is now: the arrows re-render there.
  const movedIndex = moved
    ? orderable.findIndex((folder) => folder.id === moved.folderId)
    : -1;

  const lastIndex = orderable.length - 1;

  useLayoutEffect(() => {
    const focus = document.activeElement;

    // Only when the move dropped focus or it is still on the list, never away from elsewhere.
    if (
      !moved ||
      (focus && focus !== document.body && !folderList.current?.contains(focus))
    ) {
      return;
    }

    // The first and last rows can't move further up or down.
    const atEnd =
      moved.direction === -1 ? movedIndex === 0 : movedIndex === lastIndex;

    const direction = atEnd ? -moved.direction : moved.direction;

    const target = folderList.current?.querySelector<HTMLButtonElement>(
      `[data-move="${CSS.escape(`${moved.folderId}:${direction}`)}"]`
    );

    if (target && !target.disabled && document.activeElement !== target) {
      target.focus();
    }
  }, [moved, movedIndex, lastIndex]);

  function moveFolder(folderId: string, direction: -1 | 1) {
    const folderIds = moveFolderInOrder(folders, folderId, direction);

    if (!folderIds) return;
    setMoved({ folderId, direction });
    reorder.mutate(folderIds);
  }

  return (
    <TooltipProvider delay={300}>
      <Dialog open={open} onOpenChange={setOpen}>
        {controlled ? null : (
          <ToolbarTooltip label="Manage folders and AI sorting" side="bottom">
            <DialogTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 rounded-full"
                />
              }
            >
              <FolderCog />
              <span className="sr-only">Manage folders and AI sorting</span>
            </DialogTrigger>
          </ToolbarTooltip>
        )}
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Folders &amp; AI sorting</DialogTitle>
            <DialogDescription>
              Organization settings are shared with everyone who can access this
              mailbox.
            </DialogDescription>
          </DialogHeader>

          <Tabs
            value={section}
            onValueChange={(value) => setSection(String(value))}
          >
            {/* Four tabs fit a phone only as words. */}
            <TabsList className="w-full max-sm:[&_svg]:hidden">
              <TabsTrigger value="folders">
                <Folder />
                Folders
              </TabsTrigger>
              <TabsTrigger value="blocked">
                <ShieldBan />
                Blocked
              </TabsTrigger>
              <TabsTrigger value="rules">
                <ListFilter />
                Rules
              </TabsTrigger>
              <TabsTrigger value="ai">
                <Sparkles />
                AI sorting
              </TabsTrigger>
            </TabsList>

            <TabsContent value="folders" className="space-y-4 pt-2">
              <form className="flex gap-2" onSubmit={createFolder}>
                <Input
                  aria-label="New folder name"
                  maxLength={80}
                  placeholder="New folder name"
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                />
                <Button
                  type="submit"
                  disabled={!newName.trim() || mutation.isPending}
                >
                  {mutation.isPending &&
                  mutation.variables?.type === "create" ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <Plus />
                  )}
                  Add
                </Button>
              </form>

              <div
                ref={folderList}
                className="border-border/70 max-h-[min(23rem,50vh)] overflow-y-auto border-y"
              >
                {orderable.map((folder, index) => (
                  <div
                    key={folder.id}
                    className="border-border/60 flex min-h-12 items-center gap-2 border-b px-1 py-2 last:border-b-0"
                  >
                    {editingId === folder.id ? (
                      <form
                        className="flex min-w-0 flex-1 items-center gap-2"
                        onSubmit={(event) => renameFolder(event, folder.id)}
                      >
                        <Input
                          autoFocus
                          aria-label={`Rename ${folder.name}`}
                          maxLength={80}
                          value={editingName}
                          onChange={(event) =>
                            setEditingName(event.target.value)
                          }
                        />
                        <ToolbarTooltip label="Save name">
                          <Button
                            type="submit"
                            variant="ghost"
                            size="icon-sm"
                            disabled={!editingName.trim() || mutation.isPending}
                          >
                            <Check />
                            <span className="sr-only">Save name</span>
                          </Button>
                        </ToolbarTooltip>
                        <ToolbarTooltip label="Cancel rename">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            disabled={mutation.isPending}
                            onClick={() => setEditingId(null)}
                          >
                            <X />
                            <span className="sr-only">Cancel rename</span>
                          </Button>
                        </ToolbarTooltip>
                      </form>
                    ) : (
                      <>
                        <FolderGlyph
                          folder={folder}
                          className="text-muted-foreground ml-2 size-4 shrink-0"
                        />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          {folder.name}
                        </span>
                        <div className="flex shrink-0 items-center">
                          <ToolbarTooltip label="Move up">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              data-move={`${folder.id}:-1`}
                              disabled={index === 0}
                              onClick={() => moveFolder(folder.id, -1)}
                            >
                              <ArrowUp />
                              <span className="sr-only">
                                Move {folder.name} up
                              </span>
                            </Button>
                          </ToolbarTooltip>
                          <ToolbarTooltip label="Move down">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              data-move={`${folder.id}:1`}
                              disabled={index === orderable.length - 1}
                              onClick={() => moveFolder(folder.id, 1)}
                            >
                              <ArrowDown />
                              <span className="sr-only">
                                Move {folder.name} down
                              </span>
                            </Button>
                          </ToolbarTooltip>
                          {folder.kind === "custom" ? (
                            <>
                              <ToolbarTooltip label="Rename">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  disabled={mutation.isPending}
                                  onClick={() => {
                                    setEditingId(folder.id);
                                    setEditingName(folder.name);
                                  }}
                                >
                                  <Pencil />
                                  <span className="sr-only">
                                    Rename {folder.name}
                                  </span>
                                </Button>
                              </ToolbarTooltip>
                              <ToolbarTooltip label="Delete">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  className="text-destructive"
                                  disabled={mutation.isPending}
                                  onClick={() => {
                                    setOpen(false);
                                    setDeleteCandidate(folder);
                                  }}
                                >
                                  <Trash2 />
                                  <span className="sr-only">
                                    Delete {folder.name}
                                  </span>
                                </Button>
                              </ToolbarTooltip>
                            </>
                          ) : (
                            // System folders keep their names; the blanks keep the arrows in one column.
                            <span aria-hidden="true" className="w-16" />
                          )}
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
              <p className="text-muted-foreground text-xs leading-relaxed">
                Inbox always comes first. Sent, Archive, Spam and Trash can move
                but keep their names.
                {hasCustomFolders
                  ? null
                  : " Create a folder to organize Inbox conversations and give AI another destination."}
              </p>
            </TabsContent>

            <TabsContent value="blocked" className="pt-2">
              <BlockedSendersManager
                mailboxId={mailboxId}
                active={open && section === "blocked"}
              />
            </TabsContent>

            <TabsContent value="rules" className="pt-2">
              <MailboxRules
                mailboxId={mailboxId}
                folders={folders}
                active={open && section === "rules"}
              />
            </TabsContent>

            <TabsContent value="ai" keepMounted className="space-y-4 pt-2">
              <MailboxAiSettings
                mailboxId={mailboxId}
                active={open && section === "ai"}
              />
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(deleteCandidate)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setDeleteCandidate(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {deleteCandidate?.name}?</DialogTitle>
            <DialogDescription>
              The folder will disappear for everyone. Its conversations will
              return to Inbox.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose
              render={<Button type="button" variant="outline" />}
              onClick={() => setOpen(true)}
            >
              Cancel
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={mutation.isPending}
              onClick={() => {
                if (deleteCandidate) {
                  mutation.mutate({
                    type: "delete",
                    folderId: deleteCandidate.id,
                  });
                }
              }}
            >
              {mutation.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Trash2 />
              )}
              Delete folder
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}
