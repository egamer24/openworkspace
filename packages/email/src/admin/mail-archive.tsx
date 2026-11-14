import {
  Button,
  Skeleton,
  responseJson,
  adminPanelClass,
  AdminPanelBody,
  AdminPanelHeader,
} from "@open-workspace/core/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, LoaderCircle, Play } from "lucide-react";
import { toast } from "sonner";

import { mailApi } from "../lib/mail-api";

const ARCHIVE_KEY = ["admin-mail-archive"] as const;

function formatTime(value: number) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

/** Administration → Mail archive: counts, messages not archived yet, and Archive now. */
export function MailArchive() {
  const client = useQueryClient();

  const status = useQuery({
    queryKey: ARCHIVE_KEY,
    queryFn: async () => responseJson(await mailApi.api.mail.archive.$get()),
  });

  const run = useMutation({
    mutationFn: async () =>
      responseJson(await mailApi.api.mail.archive.run.$post()),
    onSuccess: async () => {
      toast.success("Archiving the open messages");
      await client.invalidateQueries({ queryKey: ARCHIVE_KEY });
    },
    onError: (error) => toast.error(error.message),
  });

  const { data } = status;

  return (
    <div className="max-w-4xl">
      <div className={adminPanelClass}>
        <AdminPanelHeader
          Icon={Archive}
          title="Mail archive"
          description="A write-once copy of every received and sent message, in a bucket of its own."
        />
        <AdminPanelBody className="space-y-4">
          {status.isLoading ? (
            <Skeleton className="h-20" />
          ) : data?.enabled ? (
            <>
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
                {data.years ? (
                  <>
                    <dt className="text-muted-foreground">Locked for</dt>
                    <dd>
                      {data.years === 1 ? "1 year" : `${data.years} years`}
                    </dd>
                  </>
                ) : null}
                <dt className="text-muted-foreground">Archived</dt>
                <dd>{data.archived}</dd>
                <dt className="text-muted-foreground">Waiting</dt>
                <dd>{data.pending}</dd>
                <dt className="text-muted-foreground">Failed</dt>
                <dd>{data.failed}</dd>
              </dl>
              {data.open.length ? (
                <ul
                  aria-label="Messages not archived yet"
                  className="divide-border/70 border-border divide-y rounded-lg border"
                >
                  {data.open.map((entry) => (
                    <li key={entry.id} className="px-3.5 py-2.5 text-sm">
                      <span className="block truncate font-medium">
                        {entry.mailbox ?? "Deleted address"} ·{" "}
                        {entry.direction === "incoming" ? "received" : "sent"}{" "}
                        {formatTime(entry.createdAt)}
                      </span>
                      <span className="text-muted-foreground block text-xs break-all">
                        {entry.lastError ?? "Waiting for its first copy"}
                        {entry.attempts ? ` · ${entry.attempts} tries` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <Button
                variant="outline"
                disabled={run.isPending}
                onClick={() => run.mutate()}
              >
                {run.isPending ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <Play />
                )}
                Archive now
              </Button>
            </>
          ) : (
            <p className="text-muted-foreground text-sm">
              The mail archive is off. Deploy with{" "}
              <code className="text-foreground">
                {"Email({ archive: { years: 10 } })"}
              </code>{" "}
              to keep a write-once copy of every message.
            </p>
          )}
        </AdminPanelBody>
      </div>
    </div>
  );
}
