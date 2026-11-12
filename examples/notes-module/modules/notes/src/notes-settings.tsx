import {
  AdminPanelBody,
  adminPanelClass,
  AdminPanelHeader,
  RadioCard,
  RadioGroup,
  responseJson,
  Skeleton,
} from "@open-workspace/core/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownAZ, Clock, NotebookPen } from "lucide-react";
import { toast } from "sonner";

import { noteOrders } from "../shared/module";
import type { NoteOrder } from "../shared/module";
import { notesApi, notesKeys } from "./api";

const orders: {
  value: NoteOrder;
  label: string;
  description: string;
  Icon: typeof Clock;
}[] = [
  {
    value: "newest",
    label: "Newest first",
    description: "What you wrote last is on top.",
    Icon: Clock,
  },
  {
    value: "title",
    label: "By title",
    description: "A to Z, for notes you look things up in.",
    Icon: ArrowDownAZ,
  },
];

/** Settings → Notes: how the app lists a person's notes, kept per account. */
export function NotesSettings() {
  const client = useQueryClient();

  const preferences = useQuery({
    queryKey: notesKeys.preferences,
    queryFn: async () =>
      responseJson(await notesApi.api.notes.preferences.$get()),
  });

  const save = useMutation({
    mutationFn: async (order: NoteOrder) =>
      responseJson(
        await notesApi.api.notes.preferences.$put({ json: { order } })
      ),
    onSuccess: (result) => {
      client.setQueryData(notesKeys.preferences, result);
      void client.invalidateQueries({ queryKey: notesKeys.own });
      toast.success(
        result.order === "title"
          ? "Notes are listed by title"
          : "Newest notes come first"
      );
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <div className={adminPanelClass}>
      <AdminPanelHeader
        Icon={NotebookPen}
        title="Order"
        description="How the Notes app lists what you wrote."
      />
      <AdminPanelBody>
        {preferences.isPending ? (
          <Skeleton className="h-28 rounded-lg" />
        ) : (
          <RadioGroup
            aria-label="Order notes"
            className="sm:grid-cols-2"
            value={save.isPending ? save.variables : preferences.data?.order}
            onValueChange={(value) => {
              const order = noteOrders.find((item) => item === value);

              if (order) save.mutate(order);
            }}
          >
            {orders.map(({ value, label, description, Icon }) => (
              <RadioCard key={value} value={value} indicator={false}>
                <Icon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{label}</span>
                  <span className="text-muted-foreground mt-0.5 block text-xs">
                    {description}
                  </span>
                </span>
              </RadioCard>
            ))}
          </RadioGroup>
        )}
      </AdminPanelBody>
    </div>
  );
}
