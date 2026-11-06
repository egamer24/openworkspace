import type { CalendarAttendee, ParticipationStatus } from "../../shared/calendar";
import { Badge } from "@/components/ui/badge";

const statusCopy: Record<ParticipationStatus, { label: string; variant: "success" | "warning" | "destructive" | "outline" }> = {
  ACCEPTED: { label: "Accepted", variant: "success" },
  TENTATIVE: { label: "Maybe", variant: "warning" },
  DECLINED: { label: "Declined", variant: "destructive" },
  DELEGATED: { label: "Delegated", variant: "outline" },
  "NEEDS-ACTION": { label: "Awaiting reply", variant: "outline" },
};

export function ParticipationBadge({ status }: { status: ParticipationStatus }) {
  const copy = statusCopy[status];
  return <Badge variant={copy.variant}>{copy.label}</Badge>;
}

export function AttendeeList({ attendees }: { attendees: CalendarAttendee[] }) {
  if (!attendees.length) return null;
  return (
    <ul className="space-y-1 text-sm" aria-label="Attendees">
      {attendees.map((attendee) => (
        <li key={attendee.address} className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate">
            {attendee.name ? `${attendee.name} <${attendee.address}>` : attendee.address}
            {attendee.role === "OPT-PARTICIPANT" && <span className="text-muted-foreground"> (optional)</span>}
          </span>
          <ParticipationBadge status={attendee.partstat} />
        </li>
      ))}
    </ul>
  );
}
