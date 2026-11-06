import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ChevronRight,
  Download,
  File,
  Folder,
  FolderPlus,
  HardDrive,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Search,
  Share2,
  Trash2,
  Upload,
  Users,
  FolderInput,
} from "lucide-react";
import { useRef, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { attachmentPreview } from "../../shared/attachment-preview";
import { MAX_DRIVE_UPLOAD_BYTES } from "../../shared/drive";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { api, responseJson } from "@/lib/api";
import { cn } from "@/lib/utils";
import { AttachmentPreviewDialog } from "@/mail/attachment-preview-dialog";
import { uploadComposerFile } from "@/mail/composer-upload-client";
import { formatBytes } from "@/mail/format-bytes";
import { listDriveItems, MoveDialog, NameDialog, ShareDialog, type DriveEntry } from "./drive-dialogs";
import { useDriveStatus } from "./drive-status";

type View = "files" | "shared" | "trash";
type Sort = "name" | "date" | "size";
type DialogState =
  | { type: "folder" }
  | { type: "rename" | "move" | "share" | "preview"; item: DriveEntry }
  | null;

const views: Array<{ id: View; label: string; Icon: typeof HardDrive }> = [
  { id: "files", label: "My Drive", Icon: HardDrive },
  { id: "shared", label: "Shared with me", Icon: Users },
  { id: "trash", label: "Trash", Icon: Trash2 },
];

function contentUrl(item: DriveEntry, inline = false) {
  return `/api/drive/items/${encodeURIComponent(item.id)}/content${inline ? "?inline=true" : ""}`;
}

export function DrivePage() {
  const status = useDriveStatus();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const view = (["shared", "trash"].includes(params.get("view") ?? "") ? params.get("view") : "files") as View;
  const folderId = params.get("folder") ?? undefined;
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search.trim(), 250);
  const [sort, setSort] = useState<Sort>("name");
  const [order, setOrder] = useState<"asc" | "desc">("asc");
  const [dialog, setDialog] = useState<DialogState>(null);
  const [uploads, setUploads] = useState<Array<{ name: string; progress: number }>>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  const searching = view === "files" && debouncedSearch.length > 0;
  const listing = useQuery({
    queryKey: ["drive", "list", view, folderId ?? null, searching ? debouncedSearch : null, sort, order],
    queryFn: () => listDriveItems({
      view,
      parentId: searching ? undefined : folderId,
      search: searching ? debouncedSearch : undefined,
      sort,
      order,
    }),
    enabled: status.isSuccess,
  });

  if (status.isError) return <Navigate to="/" replace />;

  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ["drive"] });
    await client.invalidateQueries({ queryKey: ["drive-status"] });
  };
  async function run(action: () => Promise<unknown>, success?: string) {
    try {
      await action();
      if (success) toast.success(success);
      setDialog(null);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Something went wrong");
    }
  }
  function open(next: { view?: View; folder?: string }) {
    setSearch("");
    const query = new URLSearchParams();
    if (next.view && next.view !== "files") query.set("view", next.view);
    if (next.folder) query.set("folder", next.folder);
    setParams(query);
  }

  const role = listing.data?.role ?? "owner";
  const canWriteHere = view !== "trash" && !searching && (view === "files" || folderId !== undefined)
    && (role === "owner" || role === "editor");
  const parentId = folderId ?? null;

  async function uploadFiles(files: FileList) {
    for (const file of Array.from(files)) {
      if (file.size > MAX_DRIVE_UPLOAD_BYTES) {
        toast.error(`${file.name} is larger than ${formatBytes(MAX_DRIVE_UPLOAD_BYTES)}`);
        continue;
      }
      setUploads((current) => [...current, { name: file.name, progress: 0 }]);
      try {
        const intent = await responseJson(await api.api.drive.uploads.$post({
          json: { parentId, name: file.name, contentType: file.type, size: file.size },
        }));
        await uploadComposerFile(intent.upload.uploadUrl, intent.upload.headers, file, (progress) => {
          setUploads((current) => current.map((entry) => entry.name === file.name ? { ...entry, progress } : entry));
        }, () => {});
        await responseJson(await api.api.drive.uploads[":id"].complete.$post({ param: { id: intent.item.id } }));
      } catch (error) {
        toast.error(error instanceof Error ? `${file.name}: ${error.message}` : `${file.name} failed to upload`);
      } finally {
        setUploads((current) => current.filter((entry) => entry.name !== file.name));
      }
    }
    await refresh();
  }

  const previewing = dialog?.type === "preview" ? dialog.item : null;
  const preview = previewing ? attachmentPreview({ filename: previewing.name, contentType: previewing.contentType ?? "" }) : null;

  function openItem(item: DriveEntry) {
    if (view === "trash") return;
    if (item.kind === "folder") {
      open({ view: view === "shared" ? "shared" : "files", folder: item.id });
    } else if (attachmentPreview({ filename: item.name, contentType: item.contentType ?? "" })) {
      setDialog({ type: "preview", item });
    } else {
      window.location.assign(contentUrl(item));
    }
  }

  return (
    <div className="flex h-dvh flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-3 sm:px-5">
        <Button variant="ghost" size="icon-sm" aria-label="Back to mail" onClick={() => navigate("/")}>
          <ArrowLeft />
        </Button>
        <span className="text-sm font-semibold">Drive</span>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          {view === "files" && (
            <label className="relative hidden w-56 sm:block">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input className="h-9 bg-surface-sunken pl-9" placeholder="Search your files" value={search} onChange={(event) => setSearch(event.target.value)} />
            </label>
          )}
          <Button variant="outline" disabled={!canWriteHere} onClick={() => setDialog({ type: "folder" })}>
            <FolderPlus /> <span className="hidden sm:inline">New folder</span>
          </Button>
          <Button disabled={!canWriteHere} onClick={() => fileInput.current?.click()}>
            <Upload /> <span className="hidden sm:inline">Upload</span>
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              if (event.target.files?.length) void uploadFiles(event.target.files);
              event.target.value = "";
            }}
          />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b p-2 sm:w-52 sm:flex-col sm:border-r sm:border-b-0 sm:p-3">
          {views.map(({ id, label, Icon }) => (
            <Button
              key={id}
              variant="ghost"
              className={cn("justify-start", view === id && !searching && "bg-accent font-semibold")}
              onClick={() => open({ view: id })}
            >
              <Icon /> {label}
            </Button>
          ))}
          {status.data && (
            <p className="hidden px-3 pt-4 text-xs text-muted-foreground sm:block">
              {formatBytes(status.data.usedBytes)} of {formatBytes(status.data.quotaBytes)} used
            </p>
          )}
        </nav>

        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div className="flex flex-wrap items-center gap-2 px-4 py-3">
            <nav aria-label="Folder path" className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-sm">
              <button type="button" className="font-medium hover:underline" onClick={() => open({ view })}>
                {searching ? `Results for “${debouncedSearch}”` : views.find((entry) => entry.id === view)!.label}
              </button>
              {!searching && [...(listing.data?.path ?? []), ...(listing.data?.folder ? [listing.data.folder] : [])].map((crumb) => (
                <span key={crumb.id} className="flex min-w-0 items-center gap-1">
                  <ChevronRight className="size-3.5 text-muted-foreground" />
                  <button type="button" className="truncate hover:underline" onClick={() => open({ view: view === "shared" ? "shared" : "files", folder: crumb.id })}>
                    {crumb.name}
                  </button>
                </span>
              ))}
            </nav>
            <select aria-label="Sort by" className="h-8 rounded-md border bg-transparent px-2 text-xs" value={sort} onChange={(event) => setSort(event.target.value as Sort)}>
              <option value="name">Name</option>
              <option value="date">Modified</option>
              <option value="size">Size</option>
            </select>
            <Button size="xs" variant="ghost" onClick={() => setOrder(order === "asc" ? "desc" : "asc")}>
              {order === "asc" ? "Ascending" : "Descending"}
            </Button>
          </div>

          {uploads.map((entry) => (
            <div key={entry.name} role="status" className="mx-4 mb-2 flex items-center gap-2 rounded-md border px-3 py-2 text-xs">
              <LoaderCircle className="size-3.5 animate-spin" />
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              <span className="tabular-nums">{Math.round(entry.progress * 100)}%</span>
            </div>
          ))}

          {listing.isLoading && <LoaderCircle className="mx-auto my-10 size-5 animate-spin text-muted-foreground" />}
          {listing.isError && <p role="alert" className="px-4 text-sm text-destructive">{listing.error.message}</p>}
          {listing.isSuccess && !listing.data.items.length && (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">
              {view === "trash" ? "Trash is empty" : view === "shared" && !folderId ? "Nothing has been shared with you yet" : "No files here"}
            </p>
          )}
          <ul className="divide-y border-t">
            {listing.data?.items.map((item) => (
              <li key={item.id} className="flex items-center gap-3 px-4 py-2 text-sm hover:bg-accent/50">
                {item.kind === "folder"
                  ? <Folder className="size-4 shrink-0 text-primary" />
                  : <File className="size-4 shrink-0 text-muted-foreground" />}
                <button type="button" className="min-w-0 flex-1 truncate text-left" disabled={view === "trash"} onClick={() => openItem(item)}>
                  {item.name}
                </button>
                {view === "shared" && <span className="hidden w-32 truncate text-xs text-muted-foreground md:block">{item.ownerName}</span>}
                <span className="hidden w-20 text-right text-xs text-muted-foreground tabular-nums sm:block">
                  {item.kind === "file" ? formatBytes(item.size) : ""}
                </span>
                <span className="hidden w-28 text-right text-xs text-muted-foreground md:block">
                  {new Date(item.updatedAt).toLocaleDateString()}
                </span>
                <ItemMenu
                  item={item}
                  view={view}
                  onRename={() => setDialog({ type: "rename", item })}
                  onMove={() => setDialog({ type: "move", item })}
                  onShare={() => setDialog({ type: "share", item })}
                  onTrash={() => void run(async () => responseJson(await api.api.drive.items[":id"].trash.$post({ param: { id: item.id } })), "Moved to trash")}
                  onRestore={() => void run(async () => responseJson(await api.api.drive.items[":id"].restore.$post({ param: { id: item.id } })), "Restored")}
                  onDelete={() => {
                    if (!window.confirm(`Delete “${item.name}” forever? This cannot be undone.`)) return;
                    void run(async () => responseJson(await api.api.drive.items[":id"].$delete({ param: { id: item.id } })), "Deleted");
                  }}
                />
              </li>
            ))}
          </ul>
        </main>
      </div>

      <Dialog open={dialog !== null} onOpenChange={(next) => { if (!next) setDialog(null); }}>
        {dialog?.type === "folder" && (
          <NameDialog
            title="New folder"
            initialName=""
            submitLabel="Create"
            onSubmit={(name) => run(async () => responseJson(await api.api.drive.folders.$post({ json: { parentId, name } })))}
          />
        )}
        {dialog?.type === "rename" && (
          <NameDialog
            title="Rename"
            initialName={dialog.item.name}
            submitLabel="Rename"
            onSubmit={(name) => run(async () => responseJson(await api.api.drive.items[":id"].$patch({ param: { id: dialog.item.id }, json: { name } })))}
          />
        )}
        {dialog?.type === "move" && (
          <MoveDialog
            item={dialog.item}
            onMove={(target) => run(async () => responseJson(await api.api.drive.items[":id"].$patch({ param: { id: dialog.item.id }, json: { parentId: target } })), "Moved")}
          />
        )}
        {dialog?.type === "share" && <ShareDialog item={dialog.item} />}
        {previewing && preview && (
          <AttachmentPreviewDialog
            attachment={{ filename: previewing.name, size: previewing.size }}
            preview={preview}
            previewUrl={contentUrl(previewing, true)}
            downloadUrl={contentUrl(previewing)}
          />
        )}
      </Dialog>
    </div>
  );
}

function ItemMenu({ item, view, onRename, onMove, onShare, onTrash, onRestore, onDelete }: {
  item: DriveEntry;
  view: View;
  onRename: () => void;
  onMove: () => void;
  onShare: () => void;
  onTrash: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const canEdit = item.role === "owner" || item.role === "editor";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${item.name}`} />}>
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {view === "trash" ? (
          <>
            <DropdownMenuItem onClick={onRestore}><RotateCcw /> Restore</DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={onDelete}><Trash2 /> Delete forever</DropdownMenuItem>
          </>
        ) : (
          <>
            {item.kind === "file" && (
              <DropdownMenuItem onClick={() => window.location.assign(contentUrl(item))}><Download /> Download</DropdownMenuItem>
            )}
            {item.role === "owner" && <DropdownMenuItem onClick={onShare}><Share2 /> Share</DropdownMenuItem>}
            {canEdit && <DropdownMenuItem onClick={onRename}><Pencil /> Rename</DropdownMenuItem>}
            {canEdit && <DropdownMenuItem onClick={onMove}><FolderInput /> Move</DropdownMenuItem>}
            {canEdit && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={onTrash}><Trash2 /> Move to trash</DropdownMenuItem>
              </>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
