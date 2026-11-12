import {
  AdminListEmpty,
  adminListClass,
  Button,
  responseJson,
  Skeleton,
  useConfirm,
} from "@open-workspace/core/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ScrollText, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { formatDate, notesApi, notesKeys } from "./api";

/**
 * Administration → Notes: every note, for members given "Manage notes".
 * Core lists the section only for them, and the routes check it again.
 */
export function NotesAdmin() {
  const client = useQueryClient();
  const { confirm, dialog } = useConfirm();

  const list = useQuery({
    queryKey: notesKeys.all,
    queryFn: async () => responseJson(await notesApi.api.admin.notes.$get()),
  });

  const remove = useMutation({
    mutationFn: async (id: string) =>
      responseJson(
        await notesApi.api.admin.notes[":id"].$delete({ param: { id } })
      ),
    onSuccess: async () => {
      toast.success("Note deleted");
      await client.invalidateQueries({ queryKey: ["notes"] });
      await client.invalidateQueries({ queryKey: notesKeys.all });
    },
    onError: (error) => toast.error(error.message),
  });

  if (list.isPending) return <Skeleton className="h-40 rounded-xl" />;

  if (list.isError) {
    return <p className="text-destructive text-sm">{list.error.message}</p>;
  }

  if (list.data.notes.length === 0) {
    return (
      <div className={adminListClass}>
        <AdminListEmpty Icon={ScrollText} title="No notes yet">
          Notes people write in the Notes app are listed here.
        </AdminListEmpty>
      </div>
    );
  }

  return (
    <>
      <ul className={adminListClass} aria-label="Notes">
        {list.data.notes.map((note) => (
          <li key={note.id} className="flex items-start gap-3 px-5 py-3.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{note.title}</p>
              <p className="text-muted-foreground mt-0.5 truncate text-xs">
                {note.authorName}, {formatDate(note.createdAt)}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Delete ${note.title}`}
              className="text-muted-foreground hover:text-destructive"
              onClick={async () => {
                const confirmed = await confirm({
                  title: `Delete “${note.title}”?`,
                  description: `${note.authorName} loses this note for good.`,
                  action: "Delete note",
                  destructive: true,
                });

                if (confirmed) remove.mutate(note.id);
              }}
            >
              <Trash2 />
            </Button>
          </li>
        ))}
      </ul>
      {dialog}
    </>
  );
}
