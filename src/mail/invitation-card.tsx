import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import {
  invitationResponses,
  type InvitationResponse,
  type InvitationSummary,
} from "../../shared/calendar";
import { ParticipationBadge } from "@/calendar/attendee-status";
import { Button } from "@/components/ui/button";
import { api, responseJson } from "@/lib/api";

const responseLabels: Record<InvitationResponse, string> = {
  ACCEPTED: "Accept",
  TENTATIVE: "Maybe",
  DECLINED: "Decline",
};

/** Shown in the viewer's own time zone; all-day dates are UTC midnights. */
function when(invitation: InvitationSummary) {
  if (invitation.allDay) {
    const format = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeZone: "UTC" });
    const last = invitation.endsAt - 86_400_000;
    return last > invitation.startsAt
      ? format.formatRange(invitation.startsAt, last)
      : format.format(invitation.startsAt);
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" })
    .formatRange(invitation.startsAt, invitation.endsAt);
}

function person(value: { address: string; name: string | null } | null) {
  return value ? value.name || value.address : "Unknown organizer";
}

export function InvitationCard({
  mailboxId,
  messageId,
  invitation,
}: {
  mailboxId: string;
  messageId: string;
  invitation: InvitationSummary;
}) {
  if (invitation.method === "REPLY") {
    const answer = invitation.attendees[0];
    return answer ? (
      <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
        <CalendarDays className="size-4" />
        {person(answer)} replied to {invitation.title}
        <ParticipationBadge status={answer.partstat} />
      </p>
    ) : null;
  }
  if (invitation.method === "CANCEL") {
    return (
      <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
        <CalendarDays className="size-4" />
        {person(invitation.organizer)} cancelled {invitation.title}
      </p>
    );
  }
  return <RequestCard mailboxId={mailboxId} messageId={messageId} invitation={invitation} />;
}

function RequestCard({
  mailboxId,
  messageId,
  invitation,
}: {
  mailboxId: string;
  messageId: string;
  invitation: InvitationSummary;
}) {
  const client = useQueryClient();
  const queryKey = ["invitation", mailboxId, messageId];
  const card = useQuery({
    queryKey,
    queryFn: async ({ signal }) => responseJson(
      await api.api.mail.mailboxes[":id"].messages[":emailId"].invitation.$get(
        { param: { id: mailboxId, emailId: messageId } },
        { init: { signal } },
      ),
    ),
  });
  const respond = useMutation({
    mutationFn: async (response: InvitationResponse) => responseJson(
      await api.api.mail.mailboxes[":id"].messages[":emailId"].invitation.respond.$post({
        param: { id: mailboxId, emailId: messageId },
        json: { response },
      }),
    ),
    onSuccess: async (result) => {
      client.setQueryData(queryKey, (current: typeof card.data) =>
        current ? { ...current, response: result.response } : current);
      await client.invalidateQueries({ queryKey: ["calendar"] });
    },
    onError: (error) => toast.error(error.message),
  });
  const answered = respond.data?.response ?? card.data?.response ?? null;
  const conflicts = card.data?.conflicts.length ?? 0;

  return (
    <div className="mt-3 space-y-2 rounded-lg border border-border bg-surface p-3 text-sm">
      <div className="flex items-start gap-2">
        <CalendarDays className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="min-w-0 space-y-0.5">
          <p className="font-semibold">{invitation.title}</p>
          <p>{when(invitation)}{invitation.rrule ? " · repeats" : ""}</p>
          {invitation.location && <p className="truncate text-muted-foreground">{invitation.location}</p>}
          <p className="text-muted-foreground">Organizer: {person(invitation.organizer)}</p>
          {card.data && (
            <p className={conflicts ? "text-warning" : "text-muted-foreground"}>
              {conflicts ? "Conflicts with another event on your calendar" : "No conflicts"}
            </p>
          )}
        </div>
      </div>
      {card.data?.canRespond !== false && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Respond to invitation">
          {invitationResponses.map((response) => (
            <Button
              key={response}
              type="button"
              size="sm"
              variant={answered === response ? "default" : "outline"}
              aria-pressed={answered === response}
              disabled={respond.isPending}
              onClick={() => respond.mutate(response)}
            >
              {respond.isPending && respond.variables === response && <LoaderCircle className="animate-spin" />}
              {responseLabels[response]}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
