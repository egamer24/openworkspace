/**
 * Hand-written iTIP fixtures that follow what Google Calendar and Outlook
 * (Exchange) put in their invitation emails: Google's IANA VTIMEZONE,
 * X-GOOGLE-CONFERENCE and invite.ics; Outlook's Windows zone names,
 * X-MICROSOFT-* properties and method-only text/calendar parts.
 */
const crlf = (text: string) => text.trim().replace(/\r?\n/gu, "\r\n") + "\r\n";

const outlookTimeZone = `
BEGIN:VTIMEZONE
TZID:Pacific Standard Time
BEGIN:STANDARD
DTSTART:16010101T020000
TZOFFSETFROM:-0700
TZOFFSETTO:-0800
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:16010101T020000
TZOFFSETFROM:-0800
TZOFFSETTO:-0700
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3
END:DAYLIGHT
END:VTIMEZONE`;

export const OUTLOOK_UID =
  "040000008200E00074C5B7101A82E00800000000D0F6A9B1C2D3DA01000000000000000010000000E1B4C1F2A3D4E5F60718293A4B5C6D7E";

export const googleRequest = crlf(`
BEGIN:VCALENDAR
PRODID:-//Google Inc//Google Calendar 70.9054//EN
VERSION:2.0
CALSCALE:GREGORIAN
METHOD:REQUEST
BEGIN:VTIMEZONE
TZID:America/New_York
X-LIC-LOCATION:America/New_York
BEGIN:DAYLIGHT
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
TZNAME:EDT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
TZNAME:EST
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
DTSTART;TZID=America/New_York:20261210T100000
DTEND;TZID=America/New_York:20261210T110000
DTSTAMP:20261201T150000Z
ORGANIZER;CN=Grace Hopper:mailto:grace@gmail.example
UID:5k2v8e1qj0m3h7t9c4b6a2d1f0@google.com
ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=TRUE
 ;CN=Grace Hopper;X-NUM-GUESTS=0:mailto:grace@gmail.example
ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=
 TRUE;CN=admin@example.test;X-NUM-GUESTS=0:mailto:admin@example.test
X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij
X-MICROSOFT-CDO-OWNERAPPTID:-1393729283
CREATED:20261201T145900Z
DESCRIPTION:Quarterly planning.\\n\\nJoin with Google Meet: https://meet.goog
 le.com/abc-defg-hij
LAST-MODIFIED:20261201T150000Z
LOCATION:
SEQUENCE:0
STATUS:CONFIRMED
SUMMARY:Planning sync
TRANSP:OPAQUE
BEGIN:VALARM
ACTION:DISPLAY
DESCRIPTION:This is an event reminder
TRIGGER:-P0DT0H30M0S
END:VALARM
END:VEVENT
END:VCALENDAR`);

export const outlookRequest = crlf(`
BEGIN:VCALENDAR
METHOD:REQUEST
PRODID:Microsoft Exchange Server 2010
VERSION:2.0
${outlookTimeZone}
BEGIN:VEVENT
ORGANIZER;CN=Alan Turing:mailto:alan@contoso.example
ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Admin:MAILTO:admin@example.test
ATTENDEE;ROLE=OPT-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Ada Lovelace:MAILTO:ada@contoso.example
DESCRIPTION;LANGUAGE=en-US:Weekly design review.\\n
UID:${OUTLOOK_UID}
SUMMARY;LANGUAGE=en-US:Design review
DTSTART;TZID=Pacific Standard Time:20261208T140000
DTEND;TZID=Pacific Standard Time:20261208T150000
RRULE:FREQ=WEEKLY;UNTIL=20270126T220000Z;INTERVAL=1;BYDAY=TU;WKST=SU
CLASS:PUBLIC
PRIORITY:5
DTSTAMP:20261201T180000Z
TRANSP:OPAQUE
STATUS:CONFIRMED
SEQUENCE:0
LOCATION;LANGUAGE=en-US:Microsoft Teams Meeting
X-MICROSOFT-CDO-APPT-SEQUENCE:0
X-MICROSOFT-CDO-OWNERAPPTID:2124613285
X-MICROSOFT-CDO-BUSYSTATUS:TENTATIVE
X-MICROSOFT-CDO-INTENDEDSTATUS:BUSY
X-MICROSOFT-CDO-ALLDAYEVENT:FALSE
X-MICROSOFT-CDO-IMPORTANCE:1
X-MICROSOFT-CDO-INSTTYPE:1
X-MICROSOFT-SKYPETEAMSMEETINGURL:https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0
X-MICROSOFT-DONOTFORWARDMEETING:FALSE
X-MICROSOFT-DISALLOW-COUNTER:FALSE
X-MICROSOFT-LOCATIONS:[{"DisplayName":"Microsoft Teams Meeting","LocationAnnotation":"","LocationSource":0,"Unresolved":false,"LocationUri":""}]
BEGIN:VALARM
DESCRIPTION:REMINDER
TRIGGER;RELATED=START:-PT15M
ACTION:DISPLAY
END:VALARM
END:VEVENT
END:VCALENDAR`);

export const outlookCancel = crlf(`
BEGIN:VCALENDAR
METHOD:CANCEL
PRODID:Microsoft Exchange Server 2010
VERSION:2.0
${outlookTimeZone}
BEGIN:VEVENT
ORGANIZER;CN=Alan Turing:mailto:alan@contoso.example
ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Admin:MAILTO:admin@example.test
DESCRIPTION;LANGUAGE=en-US:\\n
UID:${OUTLOOK_UID}
SUMMARY;LANGUAGE=en-US:Canceled: Design review
DTSTART;TZID=Pacific Standard Time:20261208T140000
DTEND;TZID=Pacific Standard Time:20261208T150000
RRULE:FREQ=WEEKLY;UNTIL=20270126T220000Z;INTERVAL=1;BYDAY=TU;WKST=SU
CLASS:PUBLIC
PRIORITY:1
DTSTAMP:20261203T180000Z
TRANSP:TRANSPARENT
STATUS:CANCELLED
SEQUENCE:1
LOCATION;LANGUAGE=en-US:Microsoft Teams Meeting
X-MICROSOFT-CDO-APPT-SEQUENCE:1
X-MICROSOFT-CDO-OWNERAPPTID:2124613285
X-MICROSOFT-CDO-BUSYSTATUS:FREE
X-MICROSOFT-CDO-INTENDEDSTATUS:FREE
X-MICROSOFT-CDO-ALLDAYEVENT:FALSE
X-MICROSOFT-CDO-IMPORTANCE:2
X-MICROSOFT-CDO-INSTTYPE:1
END:VEVENT
END:VCALENDAR`);

/** Google's answer to an invitation another server organized. */
export const googleReply = (uid: string, attendee: string, partstat: string) => crlf(`
BEGIN:VCALENDAR
PRODID:-//Google Inc//Google Calendar 70.9054//EN
VERSION:2.0
CALSCALE:GREGORIAN
METHOD:REPLY
BEGIN:VEVENT
DTSTART:20261215T170000Z
DTEND:20261215T180000Z
DTSTAMP:20261205T120000Z
ORGANIZER;CN=Admin:mailto:admin@example.test
UID:${uid}
ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=${partstat};CN=Grace
  Hopper;X-NUM-GUESTS=0:mailto:${attendee}
CREATED:20261205T115900Z
DESCRIPTION:
LAST-MODIFIED:20261205T120000Z
LOCATION:
SEQUENCE:0
STATUS:CONFIRMED
SUMMARY:Launch review
TRANSP:OPAQUE
END:VEVENT
END:VCALENDAR`);

/** Exchange replies carry no ORGANIZER and prefix the summary. */
export const outlookReply = (uid: string, attendee: string, partstat: string) => crlf(`
BEGIN:VCALENDAR
METHOD:REPLY
PRODID:Microsoft Exchange Server 2010
VERSION:2.0
BEGIN:VEVENT
ATTENDEE;PARTSTAT=${partstat};CN=Ada Lovelace:MAILTO:${attendee}
COMMENT;LANGUAGE=en-US:\\n
SUMMARY;LANGUAGE=en-US:Tentative: Launch review
DTSTART:20261215T170000Z
DTEND:20261215T180000Z
UID:${uid}
CLASS:PUBLIC
PRIORITY:5
DTSTAMP:20261205T130000Z
TRANSP:OPAQUE
STATUS:CONFIRMED
SEQUENCE:0
LOCATION;LANGUAGE=en-US:
X-MICROSOFT-CDO-APPT-SEQUENCE:0
X-MICROSOFT-CDO-BUSYSTATUS:TENTATIVE
X-MICROSOFT-CDO-INTENDEDSTATUS:BUSY
END:VEVENT
END:VCALENDAR`);

/**
 * Google sends the iTIP object twice: as the text/calendar alternative and
 * as an application/ics invite.ics attachment. Outlook only uses the
 * alternative part.
 */
export function invitationMime(input: {
  from: string;
  to: string;
  subject: string;
  method: string;
  ics: string;
  style: "google" | "outlook";
  /** Raw header lines put above From, e.g. Authentication-Results. */
  headers?: string[];
}) {
  const ics = input.ics;
  const lines = [
    ...(input.headers ?? []),
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    `Message-ID: <${crypto.randomUUID()}@mail.example>`,
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="mixed"',
    "",
    "--mixed",
    'Content-Type: multipart/alternative; boundary="alt"',
    "",
    "--alt",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    input.subject,
    "--alt",
    "Content-Type: text/html; charset=UTF-8",
    "",
    `<p>${input.subject}</p>`,
    "--alt",
    `Content-Type: text/calendar; charset=UTF-8; method=${input.method}`,
    "Content-Transfer-Encoding: 7bit",
    "",
    ics,
    "--alt--",
    ...(input.style === "google"
      ? [
          "--mixed",
          'Content-Type: application/ics; name="invite.ics"',
          'Content-Disposition: attachment; filename="invite.ics"',
          "Content-Transfer-Encoding: base64",
          "",
          btoa(ics),
        ]
      : []),
    "--mixed--",
    "",
  ];
  return lines.join("\r\n");
}
