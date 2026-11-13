import { describe, expect, it } from "bun:test";

import {
  gmailMessage,
  parseGmailLabelsHeader,
  ThreadFolders,
} from "../../import/gmail.ts";
import {
  decodeWords,
  parseHeaders,
  rootThreadKey,
} from "../../import/headers.ts";

const archive = { archivedLabels: "archive" as const };

describe("Gmail labels", () => {
  it("split Takeout's header, with quotes and encoded words", () => {
    expect(
      parseGmailLabelsHeader(
        'Inbox,Opened,"Clients, 2026",=?UTF-8?B?Q2Fmw6k=?=,Work/Kilns'
      )
    ).toEqual(["Inbox", "Opened", "Clients, 2026", "Café", "Work/Kilns"]);
    expect(decodeWords("=?UTF-8?Q?Caf=C3=A9_au?= =?UTF-8?Q?_lait?=")).toBe(
      "Café au lait"
    );
  });

  it("place a message by precedence: Trash, Spam, Inbox, labels, Sent, Archive", () => {
    expect(gmailMessage(["Inbox", "Trash", "Work"], archive).placement).toBe(
      "trash"
    );
    expect(gmailMessage(["Inbox", "Spam"], archive).placement).toBe("spam");
    expect(gmailMessage(["Inbox", "Work"], archive)).toMatchObject({
      placement: "inbox",
      userLabels: ["Work"],
    });
    expect(gmailMessage(["Work"], archive).placement).toBe("archive");
    expect(gmailMessage(["Work"], { archivedLabels: "folder" }).placement).toBe(
      "inbox"
    );
    expect(gmailMessage(["Sent"], archive)).toMatchObject({
      placement: "sent",
      sent: true,
    });
    expect(
      gmailMessage(
        ["Archived", "Important", "Starred", "Category Promotions"],
        archive
      )
    ).toMatchObject({
      placement: "archive",
      userLabels: [],
    });
  });

  it("read IMAP's spelling of system labels", () => {
    expect(
      gmailMessage(["\\Inbox", "\\Important", "Work"], archive)
    ).toMatchObject({ placement: "inbox", userLabels: ["Work"] });
    expect(gmailMessage(["\\Sent"], archive)).toMatchObject({
      placement: "sent",
      sent: true,
    });
    expect(gmailMessage(["\\Draft"], archive).skip).toBe("draft");
  });

  it("read state, and mail to oneself counts as received", () => {
    expect(gmailMessage(["Inbox", "Unread"], archive).seen).toBe(false);
    expect(gmailMessage(["Inbox", "Opened"], archive).seen).toBe(true);
    expect(gmailMessage(["Inbox"], archive).seen).toBeNull();
    expect(gmailMessage(["Inbox", "Sent"], archive)).toMatchObject({
      placement: "inbox",
      sent: false,
    });
    expect(gmailMessage(["Chat"], archive).skip).toBe("chat");
  });

  it("give a thread one folder: preferred, then most used, then alphabetical", () => {
    const threads = new ThreadFolders(["Urgent"]);
    threads.add("t1", ["Work", "Clients"]);
    threads.add("t1", ["Clients"]);
    threads.add("t2", ["Beta", "Alpha"]);
    threads.add("t3", ["Work", "urgent"]);
    expect(threads.folder("t1")).toBe("Clients");
    expect(threads.folder("t2")).toBe("Alpha");
    expect(threads.folder("t3")).toBe("urgent");
    expect(threads.folder("unknown", ["Solo"])).toBe("Solo");
    expect(threads.folder("unknown")).toBeNull();
    const long = new ThreadFolders();
    long.add("t", ["x".repeat(120)]);
    expect(long.folder("t")).toHaveLength(80);
  });
});

describe("header threads", () => {
  it("key a thread by its first message", () => {
    expect(
      rootThreadKey(
        parseHeaders(
          "References: <A@x> <b@x>\nIn-Reply-To: <b@x>\nMessage-ID: <c@x>"
        )
      )
    ).toBe("mid:a@x");
    expect(
      rootThreadKey(parseHeaders("In-Reply-To: <b@x>\nMessage-ID: <c@x>"))
    ).toBe("mid:b@x");
    expect(rootThreadKey(parseHeaders("Message-ID: <c@x>"))).toBe("mid:c@x");
    expect(rootThreadKey(parseHeaders("Subject: none"))).toBeUndefined();
  });
});
