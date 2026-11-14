# Using the workspace

## People and sign-in

Everyone signs in with a passkey. There are no passwords.

To invite someone, create them under **People** with a personal address and
send them the one-time invitation link.

If someone loses their passkey, an administrator can create a one-hour
recovery link. Using it replaces their passkeys and signs them out everywhere.

Sessions end after 15 to 30 days without use.

## Mailboxes and shared inboxes

A person can have several addresses. Mailing lists deliver to their primary
one.

Under **Teams** you create team addresses. Each one is either:

- a shared inbox, which members open in the app, with read-only or
  read-and-send access, or
- a mailing list, which copies each message into every member's primary
  mailbox.

The Everyone team includes everyone, at `all@`. You also use teams to choose
who can sign in to each [single sign-on app](sso.md).

Bounces, delays and spam complaints show on the sent message.

## Folders

Members of a mailbox can reorder its folders. Inbox always stays first. On
phones, the bar at the bottom switches mailboxes and scrolls through the
folders.

Conversations in Spam are deleted permanently 30 days after they arrive
there, by default. Trash keeps mail until someone empties it. The deployment
sets both with `Email({ retention })` ([Configuration](configuration.md)). In
Trash and Spam, a line above the list says how long mail stays, and members
with send access can **Empty** the folder for everyone in the mailbox.

## Sender warnings

Incoming mail shows whether the sender passed SPF, DKIM and DMARC, and warns
you about suspicious senders.

You can block a sender for your own mailbox. People with the "Block senders"
permission can block senders and whole domains for the workspace.

With a Spamhaus key ([Deploy](deploy.md#after-the-first-deploy)), the sending
server and the domains of links in each message are also checked against Spamhaus
blocklists.

## AI sorting

With the `classification` feature on ([Configuration](configuration.md#ai)),
incoming mail is checked for spam and filed into the mailbox's custom folders.

Open **Folders & AI sorting**, next to the mailbox's folders (on phones, the
gear at the end of the bottom bar), to create folders, write rules, and set how
confident the AI must be. Mail the AI can't place stays in Inbox.

The AI files a reply only if the conversation has no earlier mail from
others, such as a thread you started; otherwise the reply stays wherever its
conversation is. A reply put in Spam gets a conversation of its own, so the
one it answers stays where it is. When you take it out of Spam (**Not spam**,
or moving it to Inbox from the app or a mail app), it goes back into that
conversation and the conversation returns to Inbox, unless that conversation
is in Trash or Spam; then it stays on its own in Inbox.

## Attachments

PDFs open in a built-in viewer. Word, Excel, PowerPoint, OpenDocument and RTF
files up to 20 MiB open there too, once converted in the background. Older
messages aren't converted.

With the `translation` feature on, **Translate** in the viewer translates the
page in place. Scanned images can't be translated.

## Notifications

Turn on push notifications under **Settings → Notifications** and choose which
mailboxes send them. On iPhone and iPad, add OpenWorkspace to the Home Screen
first, then turn them on from the installed app. Signing out, or revoking that
device's session under **Settings → Sessions**, stops them there; a session that
simply expires keeps them.

## Settings

| Page           | What it holds                                                                                 |
| -------------- | --------------------------------------------------------------------------------------------- |
| Profile        | Your profile photo (JPEG, PNG, WebP or GIF, up to 2 MB)                                       |
| Appearance     | Light, dark, or your device's theme                                                           |
| Sessions       | Where you're signed in. Revoke a session to sign that browser out and stop its notifications. |
| MCP            | How to connect an AI agent ([MCP and JMAP](mcp-and-jmap.md))                                  |
| Connected apps | The apps you approved ([MCP and JMAP](mcp-and-jmap.md#connected-apps))                        |
| Notifications  | Push notifications on this device, and which mailboxes send them                              |
| Mail apps      | The address for mail apps ([MCP and JMAP](mcp-and-jmap.md#connect-a-jmap-mail-client))        |

## Administration

Under **Administration** you manage people, teams, branding (the workspace's
name and logo), [single sign-on apps](sso.md), [webhooks](webhooks.md),
[connected apps](mcp-and-jmap.md#connected-apps),
[backups](configuration.md#backups), and the
[mail archive](configuration.md#mail-archive) if it's on.

You can let members manage people, teams, single sign-on apps, webhooks,
blocked senders, mail import, or the mail archive. A member can only manage people whose
permissions they also hold. Only administrators manage administrators, and the
last one can't be demoted.

To bring in existing mail, see [Migration](migration.md).
