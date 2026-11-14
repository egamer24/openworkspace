# MCP and JMAP

AI agents connect to the workspace over [MCP](https://modelcontextprotocol.io),
and mail apps over [JMAP](https://jmap.io). Both sign in through the browser,
and you approve what each one may do. There are no personal access tokens.

An app acts as you, and can never do more than you can. If you lose access to a
mailbox, the app loses it too.

## Connect an MCP client

1. Add this server URL to your AI client:

   ```text
   https://mail.example.com/mcp
   ```

2. The client opens a browser. Sign in and approve the access it asks for.

**Settings → MCP** shows ready-made setups for common clients.

Agents can read, send, reply to and organize mail, including attachments. With
an `admin.*` scope, they can also use the administration tools that match your
own permissions.

## Connect a JMAP mail client

The JMAP session URL is:

```text
https://mail.example.com/.well-known/jmap
```

You'll also find it under **Settings → Mail apps**. Each mailbox you can open
shows up as a separate account in the app.

Only JMAP apps that sign in through the browser can connect. Apps that use IMAP
and SMTP with a password, such as Apple Mail, Outlook or Gmail, can't.

JMAP apps can search, read, move, delete, and mark mail as read, send new mail
with attachments, import existing messages (`Email/import`), and get push
updates. A few things work differently from other servers:

- Moving a message moves its whole conversation.
- `Email/import` needs `mail.organize` and works only in your own mailboxes,
  like the [migration CLI](migration.md). A message imported before (same
  bytes or Message-ID) is `alreadyExists`.
- Read/unread is the only flag that's stored.
- Apps resync fully after changes, instead of fetching only what changed.

## Scopes

Each scope lets an app do one kind of thing. An app gets only the scopes it
asks for and you approve, and only as far as your own role allows.

| Scope                                                                                                       | Lets the app                                                                                   |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `mail.read`                                                                                                 | Read mail in the mailboxes you can open                                                        |
| `mail.send`                                                                                                 | Send, reply and forward from the mailboxes you can send from                                   |
| `mail.organize`                                                                                             | Mark as read, move, report spam, import mail, and manage folders and blocked senders           |
| `people.read`                                                                                               | See people, teams and mailboxes, if you manage something                                       |
| `admin.people`, `admin.teams`, `admin.apps`, `admin.webhooks`, `admin.blocked_senders`, `admin.import_mail` | Use the matching permission, if you hold it                                                    |
| `admin.workspace`                                                                                           | Administrators only: change branding and choose which apps may connect                         |
| `admin.access`                                                                                              | Administrators only: make people administrators, change permissions, and create recovery links |

An app that asks for nothing specific gets `mail.read`, plus staying signed in
(`offline_access`). The consent screen always appears for mail, people, and
administration scopes. Scopes your role doesn't cover are shown as unavailable
and left out. Modules can add scopes of their own.

## Connected apps

**Settings → Connected apps** lists the AI agents and mail apps you approved,
what each may do, and when it was last used. Disconnect one to revoke its
access at once. Single sign-on apps added by an administrator aren't listed
here.

Administrators see every connected app in the workspace under
**Administration → Connected apps**, with who connected it and which scopes it
has. From there they can:

- disconnect an app for one person,
- turn an app off for everyone, or
- stop new apps from connecting at all.
